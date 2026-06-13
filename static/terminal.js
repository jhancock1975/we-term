document.addEventListener("DOMContentLoaded", function () {
    var settingsStorageKey = "we-term-settings";

    function loadSettings() {
        var defaults = { cursorBlink: true, hapticFeedback: true, systemKeyboard: false, autocomplete: true, glideTyping: true };
        try {
            var raw = localStorage.getItem(settingsStorageKey);
            if (!raw) {
                return defaults;
            }
            var parsed = JSON.parse(raw);
            return {
                cursorBlink: parsed.cursorBlink !== false,
                hapticFeedback: parsed.hapticFeedback !== false,
                systemKeyboard: parsed.systemKeyboard === true,
                autocomplete: parsed.autocomplete !== false,
                glideTyping: parsed.glideTyping !== false,
            };
        } catch (err) {
            return defaults;
        }
    }

    function saveSettings(settings) {
        try {
            localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
        } catch (err) {
            // Ignore storage write failures and keep runtime behavior.
        }
    }

    var settings = loadSettings();
    var term = new Terminal({
        cursorBlink: settings.cursorBlink,
        cursorStyle: "block",
        cursorInactiveStyle: "block",
        fontSize: 14,
        fontFamily: "'Cascadia Code', 'Fira Code', 'Menlo', monospace",
        theme: {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
        },
        rightClickSelectsWord: true,
    });

    var fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById("terminal"));
    fitAddon.fit();
    var termEl = document.getElementById("terminal");
    var settingsPanel = document.getElementById("settings-panel");
    var settingsCloseBtn = document.getElementById("settings-close-btn");
    var cursorBlinkToggle = document.getElementById("cursor-blink-toggle");
    var hapticFeedbackToggle = document.getElementById("haptic-feedback-toggle");
    var systemKeyboardToggle = document.getElementById("system-keyboard-toggle");
    var autocompleteToggle = document.getElementById("autocomplete-toggle");
    var glideTypingToggle = document.getElementById("glide-typing-toggle");
    var keyboardGearEl = document.getElementById("keyboard-gear");
    var helpOverlay = document.getElementById("help-overlay");
    var helpBtn = document.getElementById("help-btn");
    var helpCloseBtn = document.getElementById("help-close-btn");
    var buttonBar = document.getElementById("button-bar");
    var touchKeyboardEl = document.getElementById("touch-keyboard");
    var touchKeyPreviewEl = document.getElementById("touch-key-preview");
    var touchKeyboardEnabled = isTouchKeyboardEnabled();
    var touchKeyboardVisible = false;
    var shiftActive = false;
    var symbolMode = false;
    var activeTouchPreviewKey = null;
    var glidePath = [];
    var gliding = false;
    // Glide is single-pointer: we latch the pointerId that started a glide and
    // ignore all other pointers, so a second finger/palm can't corrupt the path.
    var glidePointerId = null;
    var glideCandidatesList = [];
    var glideSuppressClickUntil = 0;

    // --- Custom blinking cursor overlay ---
    // xterm only renders its own cursor element while its textarea is focused.
    // On touch devices we deliberately keep it unfocused (to suppress the iOS
    // system keyboard), so xterm draws no cursor at all. This overlay draws a
    // blinking block at xterm's cursor position, independent of focus. When
    // xterm IS focused (desktop), it draws its own cursor and we hide ours to
    // avoid a double cursor.
    var touchCursorEl = document.createElement("div");
    touchCursorEl.id = "touch-cursor";
    touchCursorEl.className = "hidden";
    touchCursorEl.setAttribute("aria-hidden", "true");
    termEl.appendChild(touchCursorEl);

    function cursorOverlayBlocked() {
        if (typeof selectOverlay !== "undefined" && selectOverlay && !selectOverlay.classList.contains("hidden")) {
            return true;
        }
        if (typeof pasteOverlay !== "undefined" && pasteOverlay && !pasteOverlay.classList.contains("hidden")) {
            return true;
        }
        if (settingsPanel && !settingsPanel.classList.contains("hidden")) {
            return true;
        }
        if (helpOverlay && !helpOverlay.classList.contains("hidden")) {
            return true;
        }
        var xtermEl = termEl.querySelector(".xterm");
        return !!xtermEl && xtermEl.classList.contains("focus");
    }

    function updateTouchCursor() {
        if (cursorOverlayBlocked()) {
            touchCursorEl.classList.add("hidden");
            return;
        }
        var rows = termEl.querySelector(".xterm-rows");
        if (!rows || rows.children.length === 0) {
            touchCursorEl.classList.add("hidden");
            return;
        }
        var buffer = term.buffer.active;
        // When scrolled up into the scrollback, the live cursor is off-screen;
        // cursorY is viewport-relative and would otherwise place a phantom
        // cursor on whatever line now occupies that slot.
        if (buffer.viewportY !== buffer.baseY) {
            touchCursorEl.classList.add("hidden");
            return;
        }
        var row = buffer.cursorY;
        if (row < 0 || row >= rows.children.length) {
            touchCursorEl.classList.add("hidden");
            return;
        }
        var rowRect = rows.children[row].getBoundingClientRect();
        var termRect = termEl.getBoundingClientRect();
        var cellWidth = rowRect.width / term.cols;
        var left = (rowRect.left - termRect.left) + buffer.cursorX * cellWidth;
        var top = rowRect.top - termRect.top;
        touchCursorEl.style.left = left + "px";
        touchCursorEl.style.top = top + "px";
        touchCursorEl.style.width = cellWidth + "px";
        touchCursorEl.style.height = rowRect.height + "px";
        touchCursorEl.classList.toggle("no-blink", !settings.cursorBlink);
        touchCursorEl.classList.remove("hidden");
    }

    term.onRender(updateTouchCursor);
    term.onCursorMove(updateTouchCursor);
    term.onResize(updateTouchCursor);
    if (typeof term.onScroll === "function") {
        term.onScroll(updateTouchCursor);
    }
    window.addEventListener("resize", function () {
        requestAnimationFrame(updateTouchCursor);
    });

    // --- WebSocket with auto-reconnect ---

    var ws = null;
    var reconnectDelay = 500;
    var maxReconnectDelay = 5000;
    var currentDelay = reconnectDelay;

    function connectWs() {
        var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
        ws = new WebSocket(protocol + "//" + window.location.host + "/ws");
        ws.binaryType = "arraybuffer";

        ws.addEventListener("open", function () {
            currentDelay = reconnectDelay;
            sendResize();
        });

        ws.addEventListener("message", function (event) {
            if (event.data instanceof ArrayBuffer) {
                term.write(new Uint8Array(event.data));
            } else {
                term.write(event.data);
            }
        });

        ws.addEventListener("close", function () {
            scheduleReconnect();
        });

        ws.addEventListener("error", function () {
            // error is followed by close, reconnect handled there
        });
    }

    function scheduleReconnect() {
        setTimeout(function () {
            connectWs();
            currentDelay = Math.min(currentDelay * 2, maxReconnectDelay);
        }, currentDelay);
    }

    connectWs();

    // Reconnect when tab becomes visible again
    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "visible") {
            if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
                currentDelay = reconnectDelay;
                connectWs();
            }
        }
    });

    term.onData(function (data) {
        if (modifiers.ctrl || modifiers.meta) {
            data = applyModifiers(data);
        }
        if (ws && ws.readyState === WebSocket.OPEN) {
            var payload = JSON.stringify({ type: "input", data: data });
            ws.send(payload);
        }
    });

    function sendResize() {
        if (ws && ws.readyState === WebSocket.OPEN) {
            var payload = JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
            });
            ws.send(payload);
        }
    }

    function doFit() {
        fitAddon.fit();
        sendResize();
    }

    window.addEventListener("resize", doFit);

    // --- Toast notification ---

    var toastEl = document.getElementById("toast");
    var toastTimer = null;

    function showToast(msg) {
        toastEl.textContent = msg;
        toastEl.classList.add("show");
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toastEl.classList.remove("show");
        }, 1500);
    }

    function syncCursorBlinkState() {
        term.options.cursorBlink = settings.cursorBlink;
        cursorBlinkToggle.checked = settings.cursorBlink;
        hapticFeedbackToggle.checked = settings.hapticFeedback;
        updateTouchCursor();
        term.refresh(0, term.rows - 1);
    }

    function openSettingsPanel() {
        setTouchKeyboardVisible(false);
        hideKeyboardGear();
        settingsPanel.classList.remove("hidden");
        settingsPanel.setAttribute("aria-hidden", "false");
        cursorBlinkToggle.checked = settings.cursorBlink;
        hapticFeedbackToggle.checked = settings.hapticFeedback;
        if (systemKeyboardToggle) {
            systemKeyboardToggle.checked = settings.systemKeyboard;
        }
        if (autocompleteToggle) {
            autocompleteToggle.checked = settings.autocomplete;
        }
        if (glideTypingToggle) {
            glideTypingToggle.checked = settings.glideTyping;
        }
    }

    function closeSettingsPanel(skipFocus) {
        settingsPanel.classList.add("hidden");
        settingsPanel.setAttribute("aria-hidden", "true");
        if (!skipFocus) {
            focusTerminal();
            // In system-keyboard mode, returning to the terminal re-shows the
            // keyboard; restore the switch-back gear too.
            if (settings.systemKeyboard) {
                showKeyboardGear();
            }
        }
    }

    cursorBlinkToggle.addEventListener("change", function () {
        settings.cursorBlink = cursorBlinkToggle.checked;
        saveSettings(settings);
        syncCursorBlinkState();
    });

    hapticFeedbackToggle.addEventListener("change", function () {
        settings.hapticFeedback = hapticFeedbackToggle.checked;
        saveSettings(settings);
        syncCursorBlinkState();
    });

    if (systemKeyboardToggle) {
        systemKeyboardToggle.addEventListener("change", function () {
            settings.systemKeyboard = systemKeyboardToggle.checked;
            saveSettings(settings);
            // Switching keyboard mode reconfigures the xterm textarea (the
            // JS-keyboard lockdown installs a non-configurable focus override
            // that cannot be undone live), so reload to apply cleanly. The
            // server session persists across the reload.
            window.location.reload();
        });
    }

    if (autocompleteToggle) {
        autocompleteToggle.addEventListener("change", function () {
            settings.autocomplete = autocompleteToggle.checked;
            saveSettings(settings);
            currentLine = "";
            serverCompletions = { line: null, candidates: [] };
            renderAutocomplete();
        });
    }

    if (glideTypingToggle) {
        glideTypingToggle.addEventListener("change", function () {
            settings.glideTyping = glideTypingToggle.checked;
            saveSettings(settings);
        });
    }

    // --- Keyboard gear (system-keyboard mode) ---
    // In system-keyboard mode the JS keyboard and its controls are hidden, so
    // this floating gear gives quick access to Settings to switch back.
    function showKeyboardGear() {
        if (keyboardGearEl) {
            keyboardGearEl.classList.remove("hidden");
        }
    }

    function hideKeyboardGear() {
        if (keyboardGearEl) {
            keyboardGearEl.classList.add("hidden");
        }
    }

    if (keyboardGearEl) {
        keyboardGearEl.addEventListener("click", function (e) {
            e.preventDefault();
            e.stopPropagation();
            // Dismiss the iOS system keyboard before showing settings.
            if (term.textarea && typeof term.textarea.blur === "function") {
                term.textarea.blur();
            }
            openSettingsPanel();
        });
    }

    settingsCloseBtn.addEventListener("click", function () {
        closeSettingsPanel();
    });

    settingsPanel.addEventListener("click", function (e) {
        if (e.target === settingsPanel) {
            closeSettingsPanel();
        }
    });

    // --- Help overlay ---
    function openHelp() {
        closeSettingsPanel(true);
        setTouchKeyboardVisible(false);
        hideKeyboardGear();
        helpOverlay.classList.remove("hidden");
        helpOverlay.setAttribute("aria-hidden", "false");
    }

    function closeHelp() {
        helpOverlay.classList.add("hidden");
        helpOverlay.setAttribute("aria-hidden", "true");
        if (settings.systemKeyboard) {
            showKeyboardGear();
        }
    }

    if (helpBtn) {
        helpBtn.addEventListener("click", function () {
            openHelp();
        });
    }
    if (helpCloseBtn) {
        helpCloseBtn.addEventListener("click", function () {
            closeHelp();
        });
    }

    // --- Select overlay ---

    var selectOverlay = document.getElementById("select-overlay");
    var selectContent = document.getElementById("select-content");
    var selectCopyBtn = document.getElementById("select-copy-btn");
    var selectDoneBtn = document.getElementById("select-done-btn");
    var lastSelectedText = "";
    var suppressSelectTapUntil = 0;
    var longPressTimer = null;
    var longPressTriggered = false;
    var touchStartX = 0;
    var touchStartY = 0;
    var touchMoved = false;
    var suppressTerminalClickUntil = 0;

    function clearSelection() {
        var selection = window.getSelection();
        if (selection) {
            selection.removeAllRanges();
        }
    }

    function syncSelectState() {
        selectOverlay.dataset.selectedText = lastSelectedText;
        selectOverlay.dataset.hasSelection = lastSelectedText.trim().length > 0 ? "true" : "false";
    }

    function hasActiveSelection() {
        var selection = window.getSelection();
        return !!selection && !selection.isCollapsed && selection.toString().trim().length > 0;
    }

    function getCaretRangeFromPoint(clientX, clientY) {
        if (document.caretRangeFromPoint) {
            return document.caretRangeFromPoint(clientX, clientY);
        }
        if (document.caretPositionFromPoint) {
            var position = document.caretPositionFromPoint(clientX, clientY);
            if (!position) {
                return null;
            }
            var range = document.createRange();
            range.setStart(position.offsetNode, position.offset);
            range.collapse(true);
            return range;
        }
        return null;
    }

    function selectWordAtPoint(clientX, clientY) {
        var rangeAtPoint = getCaretRangeFromPoint(clientX, clientY);
        var textNode = selectContent.firstChild;
        if (!rangeAtPoint || !textNode || textNode.nodeType !== Node.TEXT_NODE) {
            return false;
        }

        var text = textNode.textContent || "";
        if (!text) {
            return false;
        }

        var offset = rangeAtPoint.startOffset;
        if (offset >= text.length) {
            offset = text.length - 1;
        }

        while (offset < text.length && /\s/.test(text.charAt(offset))) {
            offset += 1;
        }
        if (offset >= text.length) {
            offset = rangeAtPoint.startOffset - 1;
            while (offset >= 0 && /\s/.test(text.charAt(offset))) {
                offset -= 1;
            }
        }
        if (offset < 0 || offset >= text.length) {
            return false;
        }

        var start = offset;
        var end = offset + 1;
        while (start > 0 && !/\s/.test(text.charAt(start - 1))) {
            start -= 1;
        }
        while (end < text.length && !/\s/.test(text.charAt(end))) {
            end += 1;
        }

        var selectionRange = document.createRange();
        selectionRange.setStart(textNode, start);
        selectionRange.setEnd(textNode, end);

        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(selectionRange);
        lastSelectedText = selection.toString();
        syncSelectState();
        return true;
    }

    function selectFirstWord() {
        var textNode = selectContent.firstChild;
        if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
            return false;
        }
        var text = textNode.textContent || "";
        var match = text.match(/\S+/);
        if (!match) {
            return false;
        }

        var start = match.index;
        var end = start + match[0].length;
        var selectionRange = document.createRange();
        selectionRange.setStart(textNode, start);
        selectionRange.setEnd(textNode, end);

        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(selectionRange);
        lastSelectedText = selection.toString();
        syncSelectState();
        return true;
    }

    function getTerminalCharOffset(clientX, clientY, lines) {
        var renderedRows = termEl.querySelector(".xterm-rows");
        if (!renderedRows || renderedRows.children.length === 0) {
            return -1;
        }
        var rowIndex = -1;
        for (var i = 0; i < renderedRows.children.length; i++) {
            var rect = renderedRows.children[i].getBoundingClientRect();
            if (clientY >= rect.top && clientY <= rect.bottom) {
                rowIndex = i;
                break;
            }
        }
        if (rowIndex === -1) {
            return -1;
        }
        var rowRect = renderedRows.children[rowIndex].getBoundingClientRect();
        var cellWidth = rowRect.width / term.cols;
        var col = Math.floor((clientX - rowRect.left) / cellWidth);
        col = Math.max(0, col);
        var offset = 0;
        for (var i = 0; i < rowIndex && i < lines.length; i++) {
            offset += lines[i].length + 1;
        }
        if (rowIndex < lines.length) {
            offset += Math.min(col, lines[rowIndex].length);
        }
        return offset;
    }

    function selectWordAtOffset(offset) {
        var textNode = selectContent.firstChild;
        if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
            return false;
        }
        var text = textNode.textContent || "";
        if (!text || offset < 0 || offset >= text.length) {
            return false;
        }
        if (/\s/.test(text.charAt(offset))) {
            var fwd = offset;
            while (fwd < text.length && /\s/.test(text.charAt(fwd))) {
                fwd++;
            }
            if (fwd < text.length) {
                offset = fwd;
            } else {
                var bwd = offset;
                while (bwd >= 0 && /\s/.test(text.charAt(bwd))) {
                    bwd--;
                }
                if (bwd >= 0) {
                    offset = bwd;
                } else {
                    return false;
                }
            }
        }
        var start = offset;
        var end = offset + 1;
        while (start > 0 && !/\s/.test(text.charAt(start - 1))) {
            start--;
        }
        while (end < text.length && !/\s/.test(text.charAt(end))) {
            end++;
        }
        var selectionRange = document.createRange();
        selectionRange.setStart(textNode, start);
        selectionRange.setEnd(textNode, end);
        var selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(selectionRange);
        lastSelectedText = selection.toString();
        syncSelectState();
        return true;
    }

    function legacyCopyText(text) {
        var activeElement = document.activeElement;
        var textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.setAttribute("aria-hidden", "true");
        textarea.setAttribute("readonly", "readonly");
        textarea.style.position = "fixed";
        textarea.style.top = "0";
        textarea.style.left = "-9999px";
        textarea.style.width = "1px";
        textarea.style.height = "1px";
        textarea.style.padding = "0";
        textarea.style.border = "0";
        textarea.style.opacity = "0.01";
        textarea.style.pointerEvents = "none";
        textarea.style.fontSize = "16px";
        document.body.appendChild(textarea);
        textarea.focus({ preventScroll: true });
        textarea.select();
        textarea.setSelectionRange(0, textarea.value.length);
        var copied = false;
        try {
            copied = document.execCommand("copy");
        } catch (err) {
            copied = false;
        }
        textarea.blur();
        document.body.removeChild(textarea);
        if (activeElement && activeElement.focus) {
            activeElement.focus({ preventScroll: true });
        }
        return copied;
    }

    function writeTextToClipboard(text) {
        if (!text) {
            return Promise.resolve(false);
        }
        if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
            return navigator.clipboard.writeText(text).then(function () {
                return true;
            }, function () {
                return legacyCopyText(text);
            });
        }
        return Promise.resolve(legacyCopyText(text));
    }

    function openSelectMode(clientX, clientY) {
        setTouchKeyboardVisible(false);
        closeSettingsPanel(true);
        var lines = [];
        var renderedRows = termEl.querySelector(".xterm-rows");
        if (renderedRows && renderedRows.children.length > 0) {
            for (var rowIndex = 0; rowIndex < renderedRows.children.length; rowIndex++) {
                lines.push(renderedRows.children[rowIndex].textContent || "");
            }
        }

        if (lines.join("").trim().length === 0) {
            var buffer = term.buffer.active;
            for (var i = 0; i <= buffer.length - 1; i++) {
                var line = buffer.getLine(i);
                if (line) {
                    lines.push(line.translateToString(true));
                }
            }
        }

        var charOffset = -1;
        if (typeof clientX === "number" && typeof clientY === "number") {
            charOffset = getTerminalCharOffset(clientX, clientY, lines);
        }

        selectContent.textContent = lines.join("\n");
        selectOverlay.classList.remove("hidden");
        clearSelection();
        lastSelectedText = "";
        syncSelectState();
        suppressSelectTapUntil = Date.now() + 350;

        if (charOffset < 0 || !selectWordAtOffset(charOffset)) {
            selectFirstWord();
        }

        requestAnimationFrame(function () {
            var sel = window.getSelection();
            if (sel.rangeCount > 0) {
                var range = sel.getRangeAt(0);
                var rect = range.getBoundingClientRect();
                var containerRect = selectContent.getBoundingClientRect();
                if (rect.top < containerRect.top || rect.bottom > containerRect.bottom) {
                    selectContent.scrollTop += rect.top - containerRect.top - containerRect.height / 3;
                }
            }
        });
    }

    function closeSelectMode() {
        clearSelection();
        lastSelectedText = "";
        syncSelectState();
        selectOverlay.classList.add("hidden");
        selectContent.textContent = "";
        focusTerminal();
    }

    function doCopy() {
        var selectedText = window.getSelection().toString() || lastSelectedText;
        writeTextToClipboard(selectedText).then(function (copied) {
            showToast(copied ? "Copied" : "Copy failed");
            closeSelectMode();
        });
    }

    if (selectCopyBtn) {
        selectCopyBtn.addEventListener("click", function (e) {
            e.preventDefault();
            doCopy();
        });

        selectCopyBtn.addEventListener("touchstart", function (e) { e.preventDefault(); });
        selectCopyBtn.addEventListener("touchend", function (e) {
            e.preventDefault();
            doCopy();
        });
    }

    if (selectDoneBtn) {
        selectDoneBtn.addEventListener("click", function (e) {
            e.preventDefault();
            closeSelectMode();
        });

        selectDoneBtn.addEventListener("touchstart", function (e) { e.preventDefault(); });
        selectDoneBtn.addEventListener("touchend", function (e) {
            e.preventDefault();
            closeSelectMode();
        });
    }

    document.addEventListener("selectionchange", function () {
        if (selectOverlay.classList.contains("hidden")) {
            return;
        }
        if (hasActiveSelection()) {
            lastSelectedText = window.getSelection().toString();
            syncSelectState();
        }
    });

    // --- Paste overlay ---

    var pasteOverlay = document.getElementById("paste-overlay");
    var pasteArea = document.getElementById("paste-area");
    var pasteSendBtn = document.getElementById("paste-send-btn");
    var pasteCancelBtn = document.getElementById("paste-cancel-btn");

    function openPasteMode() {
        setTouchKeyboardVisible(false);
        closeSettingsPanel(true);
        pasteArea.value = "";
        pasteOverlay.classList.remove("hidden");
        pasteArea.focus();
    }

    function closePasteMode() {
        pasteOverlay.classList.add("hidden");
        pasteArea.value = "";
        focusTerminal();
    }

    // Capture image pastes in the paste area
    pasteArea.addEventListener("paste", function (e) {
        var items = e.clipboardData.items;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image/") === 0) {
                e.preventDefault();
                var blob = items[i].getAsFile();
                if (blob) {
                    uploadImage(blob);
                    closePasteMode();
                }
                return;
            }
        }
        // Text paste: let native paste fill the textarea, send on button click
    });

    pasteSendBtn.addEventListener("click", function () {
        var text = pasteArea.value;
        if (text) {
            sendInput(text);
            showToast("Pasted");
        }
        closePasteMode();
    });

    pasteSendBtn.addEventListener("touchstart", function (e) { e.preventDefault(); });
    pasteSendBtn.addEventListener("touchend", function (e) {
        e.preventDefault();
        var text = pasteArea.value;
        if (text) {
            sendInput(text);
            showToast("Pasted");
        }
        closePasteMode();
    });

    pasteCancelBtn.addEventListener("click", closePasteMode);
    pasteCancelBtn.addEventListener("touchstart", function (e) { e.preventDefault(); });
    pasteCancelBtn.addEventListener("touchend", function (e) {
        e.preventDefault();
        closePasteMode();
    });

    // --- Helpers ---

    function sendInput(data) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            var payload = JSON.stringify({ type: "input", data: data });
            ws.send(payload);
        }
        try { trackAutocompleteInput(data); } catch (e) { /* never break input */ }
    }

    // --- Autocomplete suggestion bar (JS-keyboard mode) ---
    // Termux-style: track the current line as the user types via the on-screen
    // keyboard, and offer a tappable bar of matching commands from history and
    // a built-in command list. Tapping replaces the line with the suggestion
    // plus a trailing space. Only active in JS-keyboard mode (system-keyboard
    // input goes through xterm's textarea and isn't tracked here).
    var autocompleteBar = document.getElementById("autocomplete-bar");
    var historyStorageKey = "we-term-history";
    var commandHistory = loadHistory();
    var currentLine = "";
    var autocompleteVisible = false;
    var acSuppressClickUntil = 0;
    var serverCompletions = { line: null, candidates: [] };
    var completionTimer = null;
    var passwordMode = false;
    var COMMON_COMMANDS = [
        "ls", "cd", "cat", "grep", "find", "echo", "pwd", "mkdir", "rmdir", "rm", "cp", "mv",
        "touch", "chmod", "chown", "ps", "kill", "top", "htop", "tail", "head", "less", "more",
        "man", "git", "ssh", "scp", "curl", "wget", "tar", "zip", "unzip", "vim", "vi", "nano",
        "emacs", "python", "python3", "pip", "node", "npm", "npx", "make", "sudo", "apt",
        "systemctl", "journalctl", "df", "du", "free", "uname", "whoami", "clear", "exit",
        "history", "export", "source", "screen", "tmux", "awk", "sed", "sort", "uniq", "wc",
        "diff", "ln", "which", "date", "sleep",
    ];

    function loadHistory() {
        try {
            var raw = localStorage.getItem(historyStorageKey);
            var arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr.slice(0, 100) : [];
        } catch (e) {
            return [];
        }
    }

    function saveHistory() {
        try {
            localStorage.setItem(historyStorageKey, JSON.stringify(commandHistory.slice(0, 100)));
        } catch (e) {
            // ignore storage failures
        }
    }

    function addToHistory(line) {
        line = (line || "").trim();
        if (!line) return;
        commandHistory = commandHistory.filter(function (h) { return h !== line; });
        commandHistory.unshift(line);
        if (commandHistory.length > 100) commandHistory.length = 100;
        saveHistory();
    }

    function autocompleteActive() {
        return touchKeyboardEnabled && !settings.systemKeyboard && settings.autocomplete && !passwordMode;
    }

    // Never offer suggestions while a password/passphrase is being entered.
    // ECHO state can't distinguish this (readline keeps ECHO off at the normal
    // prompt too), so detect it from the prompt text on the cursor's line.
    function setPasswordMode(value) {
        if (passwordMode === value) return;
        passwordMode = value;
        if (value) {
            currentLine = "";
            serverCompletions = { line: null, candidates: [] };
        }
        renderAutocomplete();
    }

    function detectPasswordPrompt() {
        if (!autocompleteBar) return;
        try {
            var buf = term.buffer.active;
            var text = "";
            if (buf.cursorY > 0) {
                var prev = buf.getLine(buf.cursorY - 1);
                if (prev) text += prev.translateToString(true) + " ";
            }
            var cur = buf.getLine(buf.cursorY);
            if (cur) text += cur.translateToString(true);
            setPasswordMode(/pass(word|phrase)/i.test(text));
        } catch (e) {
            setPasswordMode(false);
        }
    }

    function trackAutocompleteInput(data) {
        // Any real keystroke invalidates stale glide suggestions: dismiss them.
        if (glideCandidatesList.length) { glideCandidatesList = []; }
        if (!autocompleteActive() || !data) return;
        if (data.charCodeAt(0) === 0x1b) {
            // Escape sequence (arrow keys, etc.) recalls/moves the shell line in
            // ways we can't track; drop our buffer rather than corrupt it.
            currentLine = "";
            renderAutocomplete();
            scheduleCompletion();
            return;
        }
        for (var i = 0; i < data.length; i++) {
            var ch = data[i];
            var code = data.charCodeAt(i);
            if (ch === "\r" || ch === "\n") {
                addToHistory(currentLine);
                currentLine = "";
            } else if (ch === "\x7f" || ch === "\b") {
                currentLine = currentLine.slice(0, -1);
            } else if (ch === "\t") {
                currentLine = ""; // shell tab-completion desyncs us
            } else if (code === 0x03 || code === 0x15 || code === 0x17 || code === 0x0c) {
                currentLine = ""; // Ctrl-C / Ctrl-U / Ctrl-W / Ctrl-L
            } else if (code < 0x20) {
                // other control characters: ignore for tracking
            } else {
                currentLine += ch;
            }
        }
        renderAutocomplete();
        scheduleCompletion();
    }

    // Ask the server for real shell completions (compgen in the live shell's
    // cwd) for the current line, debounced. Command name for the first token,
    // file/path for later tokens.
    function scheduleCompletion() {
        if (completionTimer) {
            clearTimeout(completionTimer);
            completionTimer = null;
        }
        if (!autocompleteActive() || !currentLine.trim()) {
            return;
        }
        var lineAtRequest = currentLine;
        completionTimer = setTimeout(function () {
            fetch("/complete", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ line: lineAtRequest }),
            }).then(function (r) {
                return r.json();
            }).then(function (data) {
                serverCompletions = { line: lineAtRequest, candidates: (data && data.candidates) || [] };
                if (lineAtRequest === currentLine) {
                    renderAutocomplete();
                }
            }).catch(function () { /* completion is best-effort */ });
        }, 160);
    }

    // Build the suggestion list: history + built-in commands (full-line) merged
    // with server shell-completions (token-level). Each item carries the text
    // to insert (the full resulting line) and a display label.
    function buildItems() {
        var prefix = currentLine;
        var p = prefix.toLowerCase();
        var out = [];
        var seen = {};
        function add(display, insert) {
            if (!insert || insert === prefix || seen[insert]) return;
            seen[insert] = 1;
            out.push({ display: display, insert: insert });
        }
        commandHistory.forEach(function (h) {
            if (h.toLowerCase().indexOf(p) === 0) add(h, h);
        });
        if (prefix.indexOf(" ") === -1) {
            COMMON_COMMANDS.forEach(function (c) {
                if (c.indexOf(prefix) === 0) add(c, c);
            });
        }
        if (serverCompletions.line === prefix && serverCompletions.candidates.length) {
            var lastSpace = prefix.lastIndexOf(" ");
            var head = lastSpace >= 0 ? prefix.slice(0, lastSpace + 1) : "";
            serverCompletions.candidates.forEach(function (cand) {
                add(cand, head + cand);
            });
        }
        return out.slice(0, 12);
    }

    function setAutocompleteVisible(visible) {
        if (autocompleteVisible === visible) return;
        autocompleteVisible = visible;
        autocompleteBar.classList.toggle("hidden", !visible);
        autocompleteBar.setAttribute("aria-hidden", visible ? "false" : "true");
        requestAnimationFrame(doFit);
    }

    function recentHistoryItems() {
        return commandHistory.slice(0, 12).map(function (h) {
            return { display: h, insert: h };
        });
    }

    function renderAutocomplete() {
        if (!autocompleteBar) return;
        // Persistent strip: visible whenever the on-screen keyboard is up (and
        // autocomplete is enabled and we're not in a password prompt). Its
        // height is fixed in CSS, so changing the chips never resizes the
        // terminal - only showing/hiding the whole strip does.
        if (!autocompleteActive() || !touchKeyboardVisible) {
            setAutocompleteVisible(false);
            return;
        }
        if (glideCandidatesList.length) {
            autocompleteBar.innerHTML = glideCandidatesList.map(function (w) {
                return '<button class="ac-chip ac-glide" type="button" data-glide-value="' + escapeHtml(w) + '">' + escapeHtml(w) + "</button>";
            }).join("");
            setAutocompleteVisible(true);
            return;
        }
        var items = currentLine.trim() ? buildItems() : recentHistoryItems();
        autocompleteBar.innerHTML = items.map(function (it) {
            return '<button class="ac-chip" type="button" data-ac-value="' + escapeHtml(it.insert) + '">' + escapeHtml(it.display) + "</button>";
        }).join("");
        setAutocompleteVisible(true);
    }

    function applyAutocomplete(suggestion) {
        var erase = "";
        for (var i = 0; i < currentLine.length; i++) {
            erase += "\x7f";
        }
        sendInput(erase + suggestion + " ");
        triggerHapticFeedback();
    }

    function applyGlideWord(word) {
        glideCandidatesList = [];
        sendInput(word + " ");
        triggerHapticFeedback();
        renderAutocomplete();
    }

    // Dispatch a tapped autocomplete-bar chip: glide-word chips win over
    // ordinary completion chips. Shared by the bar's touchend and click handlers.
    function applyChip(chip) {
        var glideVal = chip.getAttribute("data-glide-value");
        if (glideVal !== null) { applyGlideWord(glideVal); return; }
        applyAutocomplete(chip.getAttribute("data-ac-value"));
    }

    if (autocompleteBar) {
        var acTouchX = 0;
        var acTouchY = 0;
        var acMoved = false;
        autocompleteBar.addEventListener("touchstart", function (e) {
            acTouchX = e.touches[0].clientX;
            acTouchY = e.touches[0].clientY;
            acMoved = false;
        }, { passive: true });
        autocompleteBar.addEventListener("touchmove", function (e) {
            if (Math.abs(e.touches[0].clientX - acTouchX) > 10 || Math.abs(e.touches[0].clientY - acTouchY) > 10) {
                acMoved = true;
            }
        }, { passive: true });
        autocompleteBar.addEventListener("touchend", function (e) {
            var chip = e.target.closest(".ac-chip");
            if (!chip || acMoved) return;
            e.preventDefault();
            acSuppressClickUntil = Date.now() + 400;
            applyChip(chip);
        });
        autocompleteBar.addEventListener("click", function (e) {
            var chip = e.target.closest(".ac-chip");
            if (!chip) return;
            e.preventDefault();
            if (Date.now() < acSuppressClickUntil) return;
            applyChip(chip);
        });

        // Detect password/passphrase prompts from terminal output as it renders.
        term.onRender(detectPasswordPrompt);
    }

    function uploadImage(blob) {
        var formData = new FormData();
        formData.append("image", blob);

        showToast("Uploading image...");

        fetch("/upload", { method: "POST", body: formData })
            .then(function (res) { return res.json(); })
            .then(function (data) {
                if (data.path) {
                    sendInput(data.path + " ");
                    showToast("Image saved");
                } else {
                    showToast("Upload failed");
                }
                focusTerminal();
            })
            .catch(function () {
                showToast("Upload failed");
                focusTerminal();
            });
    }

    // Handle paste events directly on the terminal (desktop Ctrl+V)
    termEl.addEventListener("paste", function (e) {
        e.preventDefault();
        var items = e.clipboardData.items;
        for (var i = 0; i < items.length; i++) {
            if (items[i].type.indexOf("image/") === 0) {
                var blob = items[i].getAsFile();
                if (blob) uploadImage(blob);
                return;
            }
        }
        var text = e.clipboardData.getData("text/plain");
        if (text) {
            sendInput(text);
            showToast("Pasted");
        }
    });

    // --- Button bar ---

    var modifiers = { ctrl: false, meta: false };

    var keyMap = {
        up: "\x1b[A",
        down: "\x1b[B",
        right: "\x1b[C",
        left: "\x1b[D",
        pageup: "\x1b[5~",
        pagedown: "\x1b[6~",
        enter: "\r",
        tab: "\t",
        escape: "\x1b",
        backspace: "\x7f",
        space: " ",
    };

    function applyModifiers(seq) {
        if (modifiers.ctrl && seq.length === 1) {
            var code = seq.toUpperCase().charCodeAt(0);
            if (code >= 64 && code <= 95) {
                seq = String.fromCharCode(code - 64);
            }
        }
        if (modifiers.meta) {
            seq = "\x1b" + seq;
        }
        clearModifiers();
        return seq;
    }

    function clearModifiers() {
        modifiers.ctrl = false;
        modifiers.meta = false;
        document.querySelectorAll(".modifier-btn").forEach(function (btn) {
            btn.classList.remove("active");
        });
    }

    function isTouchKeyboardEnabled() {
        if (navigator.maxTouchPoints && navigator.maxTouchPoints > 0) {
            return true;
        }
        if (window.matchMedia) {
            return window.matchMedia("(pointer: coarse)").matches || window.matchMedia("(any-pointer: coarse)").matches;
        }
        return "ontouchstart" in window;
    }

    function focusTerminal() {
        if (touchKeyboardEnabled && !settings.systemKeyboard) {
            return;
        }
        term.focus();
    }

    // What a single tap on the terminal does in JS-keyboard mode: toggle the
    // custom keyboard. (System-keyboard mode is handled in the tap handlers by
    // letting xterm focus the textarea natively, which brings up the iOS
    // keyboard reliably - a programmatic focus() inside a prevented gesture
    // does not.)
    function handleTerminalTap() {
        setTouchKeyboardVisible(!touchKeyboardVisible);
        focusTerminal();
    }

    function triggerHapticFeedback() {
        if (!settings.hapticFeedback || !touchKeyboardEnabled) {
            return;
        }
        if (navigator.vibrate) {
            navigator.vibrate(10);
        }
    }

    function escapeHtml(value) {
        return String(value)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    function getTouchKeyboardRows() {
        if (symbolMode) {
            return [
                [
                    { key: "escape", label: "Esc" }, { char: "[" }, { char: "]" }, { char: "{" }, { char: "}" }, { char: "(" }, { char: ")" }, { char: "<" }, { char: ">" }, { char: "=" }, { char: "+" },
                ],
                [
                    { char: "!" }, { char: "@" }, { char: "#" }, { char: "$" }, { char: "%" }, { char: "^" }, { char: "&" }, { char: "*" }, { char: "?" }, { char: "/" },
                ],
                [
                    { char: ":" }, { char: ";" }, { char: "'" }, { char: "\"" }, { char: "`" }, { char: "~" }, { char: "|" }, { char: "\\" }, { char: "_" }, { char: "-" },
                ],
                [
                    { key: "letters", label: "ABC", className: "wide" }, { char: "." }, { char: "," }, { char: "$" }, { char: "*" }, { char: "\"" }, { key: "backspace", label: "⌫", className: "wide" },
                ],
                [
                    { key: "space", label: "Space", className: "extra-wide" }, { key: "enter", label: "Enter", className: "wide" },
                ],
            ];
        }
        return [
            [
                { char: "1", shiftChar: "!" }, { char: "2", shiftChar: "@" }, { char: "3", shiftChar: "#" }, { char: "4", shiftChar: "$" }, { char: "5", shiftChar: "%" }, { char: "6", shiftChar: "^" }, { char: "7", shiftChar: "&" }, { char: "8", shiftChar: "*" }, { char: "9", shiftChar: "(" }, { char: "0", shiftChar: ")" },
            ],
            [
                { char: "q" }, { char: "w" }, { char: "e" }, { char: "r" }, { char: "t" }, { char: "y" }, { char: "u" }, { char: "i" }, { char: "o" }, { char: "p" }, { key: "backspace", label: "⌫", className: "wide" },
            ],
            [
                { char: "a" }, { char: "s" }, { char: "d" }, { char: "f" }, { char: "g" }, { char: "h" }, { char: "j" }, { char: "k" }, { char: "l" }, { char: "-", shiftChar: "_" },
            ],
            [
                { key: "shift", label: "⇧", className: "wide" }, { char: "z" }, { char: "x" }, { char: "c" }, { char: "v" }, { char: "b" }, { char: "n" }, { char: "m" }, { char: ".", shiftChar: ">" }, { char: ",", shiftChar: "<" },
            ],
            [
                { key: "symbols", label: "Sym", className: "wide" }, { key: "escape", label: "Esc" }, { key: "space", label: "Space", className: "extra-wide" }, { key: "enter", label: "Enter", className: "wide" },
            ],
        ];
    }

    function getTouchKeyLabel(keyDef) {
        if (keyDef.key) {
            return keyDef.label;
        }
        if (shiftActive && keyDef.shiftChar) {
            return keyDef.shiftChar;
        }
        if (shiftActive && keyDef.char >= "a" && keyDef.char <= "z") {
            return keyDef.char.toUpperCase();
        }
        return keyDef.char;
    }

    function getTouchKeyOutput(keyDef) {
        if (shiftActive && keyDef.shiftChar) {
            return keyDef.shiftChar;
        }
        if (shiftActive && keyDef.char >= "a" && keyDef.char <= "z") {
            return keyDef.char.toUpperCase();
        }
        return keyDef.char;
    }

    // Glide typing: map an ordered list of crossed keys to up to 3 dictionary
    // words. A glide word starts and ends at the path endpoints and its letters
    // appear in order somewhere along the path. Ranked by frequency (list order).
    function isSubsequence(word, pathKeys) {
        var pi = 0;
        for (var ci = 0; ci < word.length; ci++) {
            // A doubled letter in the word maps to a single path key, since a
            // glide collapses consecutive identical keys (g-o-o-d -> g,o,d).
            if (ci > 0 && word[ci] === word[ci - 1]) continue;
            while (pi < pathKeys.length && pathKeys[pi] !== word[ci]) pi++;
            if (pi >= pathKeys.length) return false;
            pi++;
        }
        return true;
    }

    function glideCandidates(pathKeys, words) {
        if (!pathKeys || pathKeys.length < 2 || !words || !words.length) {
            return [];
        }
        var first = pathKeys[0];
        var last = pathKeys[pathKeys.length - 1];
        var pathLen = pathKeys.length;
        var scored = [];
        for (var w = 0; w < words.length; w++) {
            var word = words[w];
            if (word.length < 2) continue;
            if (word[0] !== first || word[word.length - 1] !== last) continue;
            if (!isSubsequence(word, pathKeys)) continue;
            // Lower score is better: frequency rank + length-mismatch penalty.
            var score = w + Math.abs(word.length - pathLen) * 50;
            scored.push({ word: word, score: score });
        }
        scored.sort(function (a, b) { return a.score - b.score; });
        return scored.slice(0, 3).map(function (s) { return s.word; });
    }

    // Exposed for tests.
    window.__glideCandidates = glideCandidates;

    function renderTouchKeyboard() {
        if (!touchKeyboardEl) {
            return;
        }
        var rows = getTouchKeyboardRows();
        var html = rows.map(function (row) {
            var keysHtml = row.map(function (keyDef) {
                var dataTouchKey = keyDef.key || keyDef.char;
                var classNames = ["touch-key"];
                if (keyDef.className) {
                    classNames.push(keyDef.className);
                }
                if (keyDef.key === "shift" && shiftActive) {
                    classNames.push("active");
                }
                if ((keyDef.key === "symbols" && symbolMode) || (keyDef.key === "letters" && !symbolMode)) {
                    classNames.push("active");
                }
                return "<button class=\"" + classNames.join(" ") + "\" data-touch-key=\"" + escapeHtml(dataTouchKey) + "\" data-touch-label=\"" + escapeHtml(getTouchKeyLabel(keyDef)) + "\">" + escapeHtml(getTouchKeyLabel(keyDef)) + "</button>";
            }).join("");
            return "<div class=\"touch-keyboard-row\">" + keysHtml + "</div>";
        }).join("");
        touchKeyboardEl.innerHTML = html;
    }

    function showTouchKeyPreview(btn) {
        if (!touchKeyPreviewEl || !btn) {
            return;
        }
        hideTouchKeyPreview();
        activeTouchPreviewKey = btn;
        btn.classList.add("preview-source");
        touchKeyPreviewEl.textContent = btn.getAttribute("data-touch-label") || btn.textContent || "";
        touchKeyPreviewEl.classList.remove("hidden");
        touchKeyPreviewEl.setAttribute("aria-hidden", "false");

        var rect = btn.getBoundingClientRect();
        var previewWidth = Math.max(rect.width + 12, 48);
        var left = rect.left + (rect.width / 2) - (previewWidth / 2);
        var top = rect.top - 54;
        var margin = 6;

        left = Math.max(margin, Math.min(left, window.innerWidth - previewWidth - margin));
        top = Math.max(margin, top);

        touchKeyPreviewEl.style.width = previewWidth + "px";
        touchKeyPreviewEl.style.left = left + "px";
        touchKeyPreviewEl.style.top = top + "px";
    }

    function hideTouchKeyPreview() {
        if (activeTouchPreviewKey) {
            activeTouchPreviewKey.classList.remove("preview-source");
            activeTouchPreviewKey = null;
        }
        if (!touchKeyPreviewEl) {
            return;
        }
        touchKeyPreviewEl.classList.add("hidden");
        touchKeyPreviewEl.setAttribute("aria-hidden", "true");
        touchKeyPreviewEl.textContent = "";
    }

    function setTouchKeyboardVisible(visible) {
        if (!touchKeyboardEnabled || !touchKeyboardEl) {
            return;
        }
        if (touchKeyboardVisible === visible) {
            return;
        }
        touchKeyboardVisible = visible;
        touchKeyboardEl.classList.toggle("hidden", !visible);
        touchKeyboardEl.setAttribute("aria-hidden", visible ? "false" : "true");
        document.body.classList.toggle("touch-keyboard-visible", visible);
        if (!visible) {
            shiftActive = false;
            symbolMode = false;
            hideTouchKeyPreview();
        }
        renderTouchKeyboard();
        renderAutocomplete();
        requestAnimationFrame(doFit);
    }

    function handleTouchKeyboardAction(keyName) {
        hideTouchKeyPreview();
        if (keyName === "shift") {
            shiftActive = !shiftActive;
            triggerHapticFeedback();
            renderTouchKeyboard();
            return;
        }
        if (keyName === "symbols") {
            symbolMode = true;
            shiftActive = false;
            triggerHapticFeedback();
            renderTouchKeyboard();
            return;
        }
        if (keyName === "letters") {
            symbolMode = false;
            shiftActive = false;
            triggerHapticFeedback();
            renderTouchKeyboard();
            return;
        }
        var rows = getTouchKeyboardRows();
        var keyDef = null;
        for (var i = 0; i < rows.length && !keyDef; i++) {
            for (var j = 0; j < rows[i].length; j++) {
                if ((rows[i][j].key || rows[i][j].char) === keyName) {
                    keyDef = rows[i][j];
                    break;
                }
            }
        }
        if (!keyDef) {
            return;
        }

        var seq = keyDef.key ? keyMap[keyDef.key] : getTouchKeyOutput(keyDef);
        if (seq === undefined) {
            return;
        }
        if (modifiers.ctrl || modifiers.meta) {
            seq = applyModifiers(seq);
        }
        triggerHapticFeedback();
        sendInput(seq);

        if (!symbolMode && shiftActive && !keyDef.key) {
            shiftActive = false;
            renderTouchKeyboard();
        }
    }

    function configureTouchKeyboard() {
        if (!touchKeyboardEnabled) {
            return;
        }

        renderTouchKeyboard();

        var helperTextarea = termEl.querySelector(".xterm-helper-textarea");
        if (helperTextarea && !settings.systemKeyboard) {
            // Prevent the iOS system keyboard from appearing.
            // inputmode="none" tells iOS 16.4+ not to show the virtual keyboard.
            helperTextarea.setAttribute("inputmode", "none");
            helperTextarea.setAttribute("virtualkeyboardpolicy", "manual");
            helperTextarea.setAttribute("autocapitalize", "off");
            helperTextarea.setAttribute("autocomplete", "off");
            helperTextarea.setAttribute("autocorrect", "off");
            helperTextarea.setAttribute("spellcheck", "false");
            helperTextarea.setAttribute("tabindex", "-1");
            helperTextarea.readOnly = true;
            helperTextarea.setAttribute("readonly", "readonly");
            helperTextarea.disabled = true;
            helperTextarea.style.pointerEvents = "none";

            // Move the textarea off-screen so it can never be the direct
            // target of a touch event, while keeping it in the DOM for
            // xterm's internal event handling.
            helperTextarea.style.position = "fixed";
            helperTextarea.style.left = "-9999px";
            helperTextarea.style.top = "-9999px";
            helperTextarea.style.opacity = "0";

            // Override .focus() so no code (including xterm.js internals)
            // can focus the textarea and trigger the system keyboard.
            Object.defineProperty(helperTextarea, "focus", {
                value: function () {},
                writable: false,
                configurable: false,
            });

            // Safety net: if focus somehow lands on the textarea, blur
            // it immediately so the system keyboard never appears.
            helperTextarea.addEventListener("focus", function () {
                helperTextarea.blur();
            }, true);

            // Re-apply inputmode if xterm.js resets it (e.g. during fit
            // or when the terminal is re-opened).
            var textareaObserver = new MutationObserver(function () {
                if (helperTextarea.getAttribute("inputmode") !== "none") {
                    helperTextarea.setAttribute("inputmode", "none");
                }
            });
            textareaObserver.observe(helperTextarea, {
                attributes: true,
                attributeFilter: ["inputmode"],
            });
        }

        // Override term.focus() so xterm never tries to focus the helper
        // textarea on touch devices (which would summon the iOS system
        // keyboard). The custom keyboard sends input directly via sendInput().
        // In system-keyboard mode we WANT xterm focus, so leave it intact.
        if (!settings.systemKeyboard) {
            term.focus = function () {};
        }

        termEl.addEventListener("touchstart", function (e) {
            if (selectOverlay.classList.contains("hidden") === false || pasteOverlay.classList.contains("hidden") === false) {
                return;
            }
            if (!e.touches || e.touches.length !== 1) {
                return;
            }

            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchMoved = false;
            longPressTriggered = false;

            if (longPressTimer) {
                clearTimeout(longPressTimer);
            }
            longPressTimer = setTimeout(function () {
                longPressTriggered = true;
                suppressTerminalClickUntil = Date.now() + 500;
                openSelectMode(touchStartX, touchStartY);
            }, 450);
        }, { passive: true, capture: true });

        termEl.addEventListener("touchmove", function (e) {
            if (!e.touches || e.touches.length !== 1) {
                return;
            }
            var dx = Math.abs(e.touches[0].clientX - touchStartX);
            var dy = Math.abs(e.touches[0].clientY - touchStartY);
            if (dx > 10 || dy > 10) {
                touchMoved = true;
                if (longPressTimer) {
                    clearTimeout(longPressTimer);
                    longPressTimer = null;
                }
            }
        }, { passive: true, capture: true });

        termEl.addEventListener("click", function (e) {
            if (Date.now() < suppressTerminalClickUntil) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (settings.systemKeyboard) {
                // Let xterm focus the textarea natively (brings up iOS keyboard).
                showKeyboardGear();
                // Re-fit once the keyboard has finished sliding up, in case the
                // visualViewport resize doesn't fire on this device.
                setTimeout(updateLayout, 350);
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            handleTerminalTap();
        }, true);

        termEl.addEventListener("touchend", function (e) {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            if (longPressTriggered) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            if (touchMoved) {
                return;
            }
            if (settings.systemKeyboard) {
                // Don't intercept: let xterm focus the textarea natively so the
                // iOS system keyboard appears. Just expose the switch-back gear.
                showKeyboardGear();
                // Re-fit once the keyboard has finished sliding up, in case the
                // visualViewport resize doesn't fire on this device.
                setTimeout(updateLayout, 350);
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            suppressTerminalClickUntil = Date.now() + 300;
            handleTerminalTap();
        }, { passive: false, capture: true });

        termEl.addEventListener("touchcancel", function () {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            touchMoved = false;
            longPressTriggered = false;
        }, { passive: true, capture: true });

        touchKeyboardEl.addEventListener("click", function (e) {
            if (Date.now() < glideSuppressClickUntil) {
                e.preventDefault();
                return;
            }
            var btn = e.target.closest(".touch-key");
            if (!btn) {
                return;
            }
            e.preventDefault();
            handleTouchKeyboardAction(btn.getAttribute("data-touch-key"));
        });

        touchKeyboardEl.addEventListener("pointerdown", function (e) {
            var btn = e.target.closest(".touch-key");
            if (!btn) {
                return;
            }
            showTouchKeyPreview(btn);
            var k = btn.getAttribute("data-touch-key");
            // Only arm a glide when none is already in progress; a second pointer
            // landing mid-glide must not hijack or reset the active gesture.
            if (glidePointerId === null && settings.glideTyping && autocompleteActive() && /^[a-z]$/.test(k)) {
                glidePath = [k];
                gliding = false;
                glidePointerId = e.pointerId;
            } else if (glidePointerId === null) {
                glidePath = [];
                gliding = false;
                glidePointerId = null;
            }
        });

        touchKeyboardEl.addEventListener("pointermove", function (e) {
            if (e.pointerId !== glidePointerId || !glidePath.length || !settings.glideTyping || !autocompleteActive()) {
                return;
            }
            var el = document.elementFromPoint(e.clientX, e.clientY);
            var btn = el && el.closest ? el.closest(".touch-key") : null;
            if (!btn) {
                return;
            }
            var k = btn.getAttribute("data-touch-key");
            if (!/^[a-z]$/.test(k)) {
                return;
            }
            if (k !== glidePath[glidePath.length - 1]) {
                glidePath.push(k);
                gliding = glidePath.length >= 2;
                showTouchKeyPreview(btn);
            }
        });

        function finishGlide(e) {
            // Only the pointer that started the glide may finish/reset it.
            if (e && e.pointerId !== glidePointerId) {
                return;
            }
            if (gliding) {
                glideCandidatesList = glideCandidates(glidePath, window.GLIDE_WORDS || []);
                glideSuppressClickUntil = Date.now() + 500;
                renderAutocomplete();
            }
            glidePath = [];
            gliding = false;
            glidePointerId = null;
            hideTouchKeyPreview();
        }

        touchKeyboardEl.addEventListener("pointerup", finishGlide);
        touchKeyboardEl.addEventListener("pointercancel", function (e) {
            // Ignore cancels from non-glide pointers so they can't reset an active glide.
            if (e.pointerId !== glidePointerId) {
                return;
            }
            glidePath = [];
            gliding = false;
            glidePointerId = null;
            hideTouchKeyPreview();
        });
        touchKeyboardEl.addEventListener("pointerleave", function (e) {
            // While a glide pointer is actively down, a stray finger leaving the
            // keyboard bounds must NOT wipe the in-progress glide.
            if (glidePointerId !== null) {
                return;
            }
            if (activeTouchPreviewKey && !touchKeyboardEl.contains(e.relatedTarget)) {
                glidePath = [];
                gliding = false;
                hideTouchKeyPreview();
            }
        });
    }

    function handleBtnAction(btn) {
        var mod = btn.getAttribute("data-modifier");
        if (mod) {
            modifiers[mod] = !modifiers[mod];
            btn.classList.toggle("active", modifiers[mod]);
            // In system-keyboard mode the JS keyboard must stay hidden, so just
            // keep the terminal focused (system keyboard up) instead.
            if (touchKeyboardEnabled && !settings.systemKeyboard) {
                setTouchKeyboardVisible(true);
            } else {
                focusTerminal();
            }
            return;
        }

        var action = btn.getAttribute("data-action");
        if (action === "settings") {
            openSettingsPanel();
            return;
        }
        if (action === "select") {
            var rect = termEl.getBoundingClientRect();
            openSelectMode(rect.left + 48, rect.top + 24);
            return;
        }
        if (action === "paste") {
            openPasteMode();
            return;
        }

        var key = btn.getAttribute("data-key");
        if (key === "num") {
            var ch = btn.getAttribute("data-char");
            var seq = applyModifiers(ch);
            sendInput(seq);
            focusTerminal();
            return;
        }
        if (key && keyMap[key] !== undefined) {
            var seq = applyModifiers(keyMap[key]);
            sendInput(seq);
        }
        focusTerminal();
    }

    document.querySelectorAll(".bar-btn").forEach(function (btn) {
        var touchStartX = 0;
        var touchStartY = 0;

        btn.addEventListener("touchstart", function (e) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }, { passive: true });

        btn.addEventListener("touchend", function (e) {
            var dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
            var dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
            if (dx > 10 || dy > 10) return; // was a scroll, not a tap
            e.preventDefault();
            handleBtnAction(btn);
        });

        btn.addEventListener("click", function (e) {
            e.preventDefault();
            handleBtnAction(btn);
        });
    });

    syncCursorBlinkState();
    configureTouchKeyboard();

    // --- Terminal resize ---

    function updateLayout() {
        if (window.visualViewport) {
            window.scrollTo(0, 0);
            if (touchKeyboardEnabled && settings.systemKeyboard) {
                // The iOS system keyboard overlays the page rather than
                // shrinking it reliably, so the active input line ends up
                // rendered behind the keyboard. Constrain the app to the
                // visible area above the keyboard so it stays in view.
                document.body.style.height = window.visualViewport.height + "px";
            } else {
                document.body.style.height = "";
            }
        }
        doFit();
        if (touchKeyboardEnabled && settings.systemKeyboard) {
            term.scrollToBottom();
        }
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", updateLayout);
        window.visualViewport.addEventListener("scroll", updateLayout);
    }

    updateLayout();
});
