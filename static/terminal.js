document.addEventListener("DOMContentLoaded", function () {
    var settingsStorageKey = "we-term-settings";

    // Configurable button-bar buttons, in default display order. The settings
    // gear is a fixed element (always first) and is NOT part of this list. Esc
    // sits immediately to the left of Ctrl.
    var BAR_BUTTONS = [
        { id: "escape", label: "Esc", attrs: { "data-key": "escape" } },
        { id: "ctrl", label: "Ctrl", attrs: { "data-modifier": "ctrl" }, cls: "modifier-btn" },
        { id: "meta", label: "Meta", attrs: { "data-modifier": "meta" }, cls: "modifier-btn" },
        { id: "tab", label: "Tab", attrs: { "data-key": "tab" } },
        { id: "select", label: "Sel", attrs: { "data-action": "select" }, elId: "select-btn" },
        { id: "paste", label: "Paste", attrs: { "data-action": "paste" }, elId: "paste-btn" },
        { id: "pageup", label: "PgUp", attrs: { "data-key": "pageup" } },
        { id: "pagedown", label: "PgDn", attrs: { "data-key": "pagedown" } },
        // Enter GNU screen copy/scrollback mode (Ctrl-A then [), so PgUp/PgDn
        // and the arrows scroll back through a full-screen app's history. Esc
        // leaves copy mode. See docs/SCROLLBACK.md.
        { id: "screen-copy", label: "Scrl", settingsLabel: "Screen scrollback (copy mode)", attrs: { "data-key": "screencopy" } },
        { id: "up", label: "▲", settingsLabel: "Up", attrs: { "data-key": "up" } },
        { id: "down", label: "▼", settingsLabel: "Down", attrs: { "data-key": "down" } },
        { id: "left", label: "◀", settingsLabel: "Left", attrs: { "data-key": "left" } },
        { id: "right", label: "▶", settingsLabel: "Right", attrs: { "data-key": "right" } },
    ];

    function defaultBarButtonIds() {
        return BAR_BUTTONS.map(function (b) { return b.id; });
    }

    function barButtonById(id) {
        for (var i = 0; i < BAR_BUTTONS.length; i++) {
            if (BAR_BUTTONS[i].id === id) {
                return BAR_BUTTONS[i];
            }
        }
        return null;
    }

    function normalizeButtonBar(value) {
        if (!Array.isArray(value)) {
            return defaultBarButtonIds();
        }
        // Keep only known ids, drop duplicates, preserve the stored order.
        var seen = {};
        var result = [];
        for (var i = 0; i < value.length; i++) {
            var id = value[i];
            if (barButtonById(id) && !seen[id]) {
                seen[id] = true;
                result.push(id);
            }
        }
        return result;
    }

    function loadSettings() {
        var defaults = { cursorBlink: true, hapticFeedback: true, systemKeyboard: false, autocomplete: true, glideTyping: true, buttonBar: defaultBarButtonIds() };
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
                buttonBar: Array.isArray(parsed.buttonBar) ? normalizeButtonBar(parsed.buttonBar) : defaultBarButtonIds(),
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
    // Test seam: write display bytes to xterm (same as server output). Affects
    // only the rendered screen, never the shell/PTY.
    window.__termWrite = function (s) { try { term.write(s); } catch (e) { /* ignore */ } };
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
    // Remembers whether the on-screen keyboard was showing before a select/paste
    // overlay opened, so its prior shown/hidden state can be restored on close.
    // Select and paste overlays are mutually exclusive, so one slot suffices.
    var keyboardVisibleBeforeOverlay = false;
    var inOverlay = false;
    var shiftActive = false;
    var symbolMode = false;
    var activeTouchPreviewKey = null;
    var glidePath = [];
    var gliding = false;
    var glideCandidatesList = [];
    var glideTrailEl = null;        // <canvas id="glide-trail"> overlay
    var glideTrailPoints = [];      // {x,y} relative to the keyboard rect
    // --- Unified touch lifecycle state for the on-screen keyboard ---
    // Tap latency on iOS comes from the synthetic `click` (tap-delay +
    // double-tap coalescing). We drive the keyboard off raw touch events
    // instead and keep `click` only as a desktop-dev fallback, suppressed
    // after any touch via kbdSuppressClickUntil.
    var kbdTouchId = null;          // identifier of the active touch
    var kbdStartKeyEl = null;       // .touch-key the touch started on
    var kbdStartKey = null;         // its data-touch-key name
    var kbdKeyFired = false;        // typematic already emitted this press
    var kbdHoldTimer = null;        // 500ms hold-to-repeat arming timer
    var kbdRepeatTimer = null;      // typematic setInterval id
    var kbdSuppressClickUntil = 0;  // ignore synthetic click until this time
    var KBD_HOLD_MS = 500;
    var KBD_REPEAT_MS = 500;

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
    // Set from the server when the shell is reading hidden input (a password).
    // Authoritative; suppresses all input tracking and suggestions. See
    // setServerHiddenInput.
    var serverHiddenInput = false;

    // Terminal data arrives as binary frames; the server uses text frames only
    // for JSON control messages (e.g. hidden-input state). Returns true if the
    // frame was a recognized control message (and must NOT be written to the
    // terminal).
    function handleControlMessage(data) {
        if (typeof data !== "string") {
            return false;
        }
        var msg;
        try {
            msg = JSON.parse(data);
        } catch (e) {
            return false;
        }
        if (!msg || typeof msg !== "object") {
            return false;
        }
        if (msg.type === "hidden") {
            setServerHiddenInput(!!msg.value);
            return true;
        }
        return false;
    }

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
            } else if (!handleControlMessage(event.data)) {
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
        syncButtonBarOptions();
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

    // --- Button-bar configuration UI ---
    var buttonBarOptionsEl = document.getElementById("button-bar-options");

    function setBarButtonEnabled(id, enabled) {
        // Rebuild the enabled list preserving BAR_BUTTONS order, so toggling on
        // a button restores it to its canonical position.
        var enabledSet = {};
        for (var i = 0; i < settings.buttonBar.length; i++) {
            enabledSet[settings.buttonBar[i]] = true;
        }
        enabledSet[id] = enabled;
        var next = [];
        for (var j = 0; j < BAR_BUTTONS.length; j++) {
            var bid = BAR_BUTTONS[j].id;
            if (enabledSet[bid]) {
                next.push(bid);
            }
        }
        settings.buttonBar = next;
        saveSettings(settings);
        renderButtonBar();
    }

    function buildButtonBarOptions() {
        if (!buttonBarOptionsEl) {
            return;
        }
        while (buttonBarOptionsEl.firstChild) {
            buttonBarOptionsEl.removeChild(buttonBarOptionsEl.firstChild);
        }
        BAR_BUTTONS.forEach(function (def) {
            var label = document.createElement("label");
            label.className = "settings-option";
            var span = document.createElement("span");
            span.textContent = def.settingsLabel || def.label;
            var input = document.createElement("input");
            input.type = "checkbox";
            input.setAttribute("data-bar-toggle", def.id);
            input.addEventListener("change", function () {
                setBarButtonEnabled(def.id, input.checked);
            });
            label.appendChild(span);
            label.appendChild(input);
            buttonBarOptionsEl.appendChild(label);
        });
    }

    function syncButtonBarOptions() {
        if (!buttonBarOptionsEl) {
            return;
        }
        var enabledSet = {};
        for (var i = 0; i < settings.buttonBar.length; i++) {
            enabledSet[settings.buttonBar[i]] = true;
        }
        var inputs = buttonBarOptionsEl.querySelectorAll("[data-bar-toggle]");
        for (var j = 0; j < inputs.length; j++) {
            var id = inputs[j].getAttribute("data-bar-toggle");
            inputs[j].checked = !!enabledSet[id];
        }
    }

    buildButtonBarOptions();

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

    // Save the keyboard's current visibility before an overlay hides it, then
    // hide it. Capture only on the first overlay entry so a second open (which
    // cannot happen normally) won't clobber the saved value with false.
    function captureKeyboardForOverlay() {
        if (!inOverlay) {
            keyboardVisibleBeforeOverlay = touchKeyboardVisible;
            inOverlay = true;
        }
        setTouchKeyboardVisible(false);
    }

    // Restore the keyboard to whatever it was before the overlay opened. Never
    // force-show the JS keyboard in system-keyboard mode (the OS keyboard owns
    // input there); setTouchKeyboardVisible already no-ops when the JS keyboard
    // is disabled, so this just adds the system-keyboard guard.
    function restoreKeyboardAfterOverlay() {
        if (!inOverlay) {
            return;
        }
        inOverlay = false;
        if (settings.systemKeyboard) {
            return;
        }
        setTouchKeyboardVisible(keyboardVisibleBeforeOverlay);
    }

    // Position the selectable overlay exactly over the terminal's text area so
    // selecting feels in-place rather than as a full-screen sheet.
    function positionSelectOverlay() {
        var screen = termEl.querySelector(".xterm-screen") || termEl;
        var r = screen.getBoundingClientRect();
        selectOverlay.style.top = r.top + "px";
        selectOverlay.style.left = r.left + "px";
        selectOverlay.style.width = r.width + "px";
        selectOverlay.style.height = r.height + "px";
    }

    // Show the terminal's visible text as a selectable layer over the live
    // terminal. We deliberately do NOT pre-select a word: iOS only shows its
    // native Copy/Look Up callout for user-initiated selections, so the user
    // long-presses the text and iOS owns the selection + callout.
    function openSelectMode() {
        closeSettingsPanel(true);
        var lines = [];
        var renderedRows = termEl.querySelector(".xterm-rows");
        if (renderedRows && renderedRows.children.length > 0) {
            for (var i = 0; i < renderedRows.children.length; i++) {
                lines.push(renderedRows.children[i].textContent || "");
            }
        }
        if (lines.join("").trim().length === 0) {
            var buffer = term.buffer.active;
            for (var j = 0; j <= buffer.length - 1; j++) {
                var line = buffer.getLine(j);
                if (line) lines.push(line.translateToString(true));
            }
        }
        selectContent.textContent = lines.join("\n");
        positionSelectOverlay();
        selectOverlay.classList.remove("hidden");
        clearSelection();
        lastSelectedText = "";
        // Ignore the tap that ends the activating long-press so it can't
        // immediately dismiss the overlay.
        suppressSelectTapUntil = Date.now() + 400;
    }

    function closeSelectMode() {
        clearSelection();
        lastSelectedText = "";
        selectOverlay.classList.add("hidden");
        selectContent.textContent = "";
        focusTerminal();
    }

    // A tap on the overlay that leaves no selection (not a long-press select,
    // not a handle drag) dismisses select mode - no Done button needed.
    selectOverlay.addEventListener("click", function () {
        if (Date.now() < suppressSelectTapUntil) {
            return;
        }
        var sel = window.getSelection();
        if (!sel || sel.isCollapsed || sel.toString().trim().length === 0) {
            closeSelectMode();
        }
    });

    // When the user taps iOS's native "Copy" (or copies on desktop), the browser
    // puts the selection on the clipboard itself; we just confirm and dismiss.
    // Defer the close: closeSelectMode clears the selection, and doing that
    // synchronously inside the copy event would empty it before the browser's
    // default copy reads it (clipboard would come out blank).
    document.addEventListener("copy", function () {
        if (selectOverlay.classList.contains("hidden")) {
            return;
        }
        showToast("Copied");
        setTimeout(closeSelectMode, 0);
    });

    // --- Paste overlay ---

    var pasteOverlay = document.getElementById("paste-overlay");
    var pasteArea = document.getElementById("paste-area");
    var pasteSendBtn = document.getElementById("paste-send-btn");
    var pasteCancelBtn = document.getElementById("paste-cancel-btn");

    function openPasteMode() {
        captureKeyboardForOverlay();
        closeSettingsPanel(true);
        pasteArea.value = "";
        pasteOverlay.classList.remove("hidden");
        pasteArea.focus();
    }

    function closePasteMode() {
        pasteOverlay.classList.add("hidden");
        pasteArea.value = "";
        restoreKeyboardAfterOverlay();
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
    // Command history for suggestions comes ONLY from the SHELL's history file
    // (via the server /history endpoint), never from client-tracked keystrokes.
    // This is essential for safety: anything typed into an application/TUI input
    // (e.g. a password typed into a program's prompt, or a full-screen app's text
    // field) is NOT a shell command, so it never appears here. Real shell
    // commands reach the file via the shell's PROMPT_COMMAND `history -a`.
    var commandHistory = [];   // suggestion history (mirrors the shell history)
    var shellHistory = [];     // fetched from the server (HISTFILE)
    // Purge any legacy persisted history (may contain a secret captured before
    // history moved server-side).
    try { localStorage.removeItem("we-term-history"); } catch (e) { /* ignore */ }
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

    // Pull the shell's history file from the server and refresh suggestions.
    function refreshShellHistory() {
        fetch("/history").then(function (r) {
            return r.json();
        }).then(function (data) {
            shellHistory = (data && data.history) || [];
            commandHistory = shellHistory;
            renderAutocomplete();
        }).catch(function () { /* best-effort */ });
    }

    var historyRefreshTimers = [];
    function scheduleHistoryRefresh() {
        for (var i = 0; i < historyRefreshTimers.length; i++) {
            clearTimeout(historyRefreshTimers[i]);
        }
        // The shell flushes the just-run command (PROMPT_COMMAND `history -a`) at
        // its next prompt; re-read a couple of times so the new command shows
        // promptly regardless of exactly when the flush lands.
        historyRefreshTimers = [
            setTimeout(refreshShellHistory, 300),
            setTimeout(refreshShellHistory, 1300),
        ];
    }

    // Prime the shell history now and keep it fresh while the keyboard is in use.
    refreshShellHistory();
    setInterval(function () {
        if (autocompleteActive() && touchKeyboardVisible) {
            refreshShellHistory();
        }
    }, 8000);

    function autocompleteActive() {
        return touchKeyboardEnabled && !settings.systemKeyboard && settings.autocomplete &&
            !passwordMode && !serverHiddenInput && !inAlternateScreen();
    }

    // Full-screen apps (vim, less, htop, Claude Code, ...) run on the terminal's
    // alternate screen buffer. Command completion is meaningless there, and -
    // critically - their text inputs are not shell commands, so suppress all
    // tracking and suggestions while the alternate screen is active.
    function inAlternateScreen() {
        try {
            return term.buffer.active.type === "alternate";
        } catch (e) {
            return false;
        }
    }

    // Authoritative password/hidden-input signal from the server (derived from
    // the tty's echo/canon flags). Far more reliable than scraping prompt text,
    // so it's the primary defense; the prompt-text regex below is a fallback.
    // On entering hidden mode we drop any partially-tracked line so keystrokes
    // captured in the brief poll window before the signal arrived can't leak.
    function setServerHiddenInput(value) {
        if (serverHiddenInput === value) return;
        serverHiddenInput = value;
        if (value) {
            currentLine = "";
            serverCompletions = { line: null, candidates: [] };
            glideCandidatesList = [];
        }
        renderAutocomplete();
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

    // Coalesce suggestion-bar rebuilds onto an animation frame so the per-key
    // path (which calls buildItems -> dictionary/history work) never blocks the
    // keystroke handler. Keeps typing responsive and async from the bar render.
    var renderScheduled = false;
    function scheduleRender() {
        if (renderScheduled) return;
        renderScheduled = true;
        requestAnimationFrame(function () {
            renderScheduled = false;
            renderAutocomplete();
        });
    }

    function trackAutocompleteInput(data) {
        // Any real keystroke invalidates stale glide suggestions: dismiss them.
        if (glideCandidatesList.length) { glideCandidatesList = []; }
        if (!autocompleteActive() || !data) return;
        if (data.charCodeAt(0) === 0x1b) {
            // Escape sequence (arrow keys, etc.) recalls/moves the shell line in
            // ways we can't track; drop our buffer rather than corrupt it.
            currentLine = "";
            scheduleRender();
            scheduleCompletion();
            return;
        }
        for (var i = 0; i < data.length; i++) {
            var ch = data[i];
            var code = data.charCodeAt(i);
            if (ch === "\r" || ch === "\n") {
                // Don't record the typed line client-side; just re-read the
                // shell's history file shortly (the shell flushes it on Enter).
                scheduleHistoryRefresh();
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
        scheduleRender();
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

    // Binary search over a sorted string array for the lower bound: the index
    // of the first element >= target. O(log n).
    function lowerBound(arr, target) {
        var lo = 0;
        var hi = arr.length;
        while (lo < hi) {
            var mid = (lo + hi) >> 1;
            if (arr[mid] < target) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    // Build a quick lookup set of GLIDE_WORDS for the common-word ranking boost.
    // Dictionary suggestions for the last whitespace-delimited token. Returns up
    // to ~8 word strings derived from / extending the token (swim -> swims,
    // swimming, swimmer, swimsuit, ...), else []. Primary source is prefix
    // matches found via binary search over the sorted window.DICTIONARY (falls
    // back to GLIDE_WORDS if DICTIONARY is missing); a cheap stem pass over those
    // same matches surfaces forms like "run" for "running" without a full scan.
    // Ranked: shorter words first (frequency proxy), then GLIDE_WORDS-common
    // words, then alphabetical. Empty when the token is under 2 chars or
    // non-alphabetic.
    var UNKNOWN_RANK = 1e9;

    // Frequency rank of a word (0 = most common). Looked up from the aligned
    // DICTIONARY_RANK via the sorted DICTIONARY; UNKNOWN_RANK if not present.
    function wordRank(w) {
        var dict = window.DICTIONARY, ranks = window.DICTIONARY_RANK;
        if (!dict || !ranks) return UNKNOWN_RANK;
        var i = lowerBound(dict, w);
        if (i < dict.length && dict[i] === w) return ranks[i];
        return UNKNOWN_RANK;
    }

    function wordCandidates(token) {
        if (!token || token.length < 2 || !/^[a-z]+$/i.test(token)) return [];
        var t = token.toLowerCase();
        var dict = window.DICTIONARY || window.GLIDE_WORDS;
        if (!dict || !dict.length) return [];

        var cands = [];   // { w: word, r: frequency rank }
        var seen = {};
        // Scan the WHOLE prefix range (bounded for safety) and rank by frequency
        // afterwards - capping the scan alphabetically would drop common words
        // (e.g. "and"/"any") in favour of rarer earlier ones (e.g. "anal").
        var MAX_RANGE = 2000;
        var ranks = window.DICTIONARY_RANK;

        if (window.DICTIONARY) {
            var i = lowerBound(dict, t);
            var scanned = 0;
            for (; i < dict.length && scanned < MAX_RANGE; i++, scanned++) {
                var w = dict[i];
                if (w.indexOf(t) !== 0) break; // past the prefix range
                if (w === t || seen[w]) continue;
                seen[w] = 1;
                cands.push({ w: w, r: ranks ? ranks[i] : UNKNOWN_RANK });
            }
        } else {
            for (var j = 0; j < dict.length && cands.length < 60; j++) {
                var dw = dict[j];
                if (dw.indexOf(t) !== 0 || dw === t || seen[dw]) continue;
                seen[dw] = 1;
                cands.push({ w: dw, r: j });
            }
        }

        // Cheap stem pass: surface non-prefix forms (running -> run) from the
        // small GLIDE_WORDS only. No full-dictionary stem scan.
        if (typeof window.stemWord === "function" && window.GLIDE_WORDS) {
            var tStem = window.stemWord(t);
            var g = window.GLIDE_WORDS;
            for (var k = 0; k < g.length; k++) {
                var gw = g[k];
                if (gw === t || seen[gw]) continue;
                if (window.stemWord(gw) === tStem) {
                    seen[gw] = 1;
                    cands.push({ w: gw, r: wordRank(gw) });
                }
            }
        }

        cands.sort(function (a, b) {
            if (a.r !== b.r) return a.r - b.r;            // more frequent first
            if (a.w.length !== b.w.length) return a.w.length - b.w.length;
            return a.w < b.w ? -1 : (a.w > b.w ? 1 : 0);  // alphabetical
        });
        return cands.slice(0, 8).map(function (c) { return c.w; });
    }

    // Build the suggestion list. When the last token closely matches English
    // words, stem-aware word candidates lead the bar; the existing command
    // sources (history full-line, built-in COMMON_COMMANDS at command
    // position, server shell-completions token-level) follow, deduped. When
    // there's no word match, behaves exactly as before. Each item carries the
    // full resulting line to insert and a display label. Capped at 12.
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
        var lastSpace = prefix.lastIndexOf(" ");
        var head = lastSpace >= 0 ? prefix.slice(0, lastSpace + 1) : "";
        var lastToken = lastSpace >= 0 ? prefix.slice(lastSpace + 1) : prefix;
        var wc = wordCandidates(lastToken);
        wc.forEach(function (w) {
            add(w, head + w);
        });
        commandHistory.forEach(function (h) {
            if (h.toLowerCase().indexOf(p) === 0) add(h, h);
        });
        if (prefix.indexOf(" ") === -1) {
            COMMON_COMMANDS.forEach(function (c) {
                if (c.indexOf(prefix) === 0) add(c, c);
            });
        }
        if (serverCompletions.line === prefix && serverCompletions.candidates.length) {
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

        // Re-render the suggestion bar when entering/leaving the alternate screen
        // so it hides in full-screen apps (where autocomplete is suppressed) and
        // returns at the shell prompt.
        var lastAltScreen = inAlternateScreen();
        term.onRender(function () {
            var alt = inAlternateScreen();
            if (alt !== lastAltScreen) {
                lastAltScreen = alt;
                renderAutocomplete();
            }
        });
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
        // GNU screen: Ctrl-A then [ enters copy/scrollback mode.
        screencopy: "\x01[",
    };

    function applyModifiers(seq) {
        if (modifiers.ctrl && seq.length === 1) {
            var code = seq.toUpperCase().charCodeAt(0);
            if (code === 32) {
                // Ctrl-Space = Ctrl-@ = NUL (e.g. emacs set-mark), not a space.
                seq = "\x00";
            } else if (code >= 64 && code <= 95) {
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
                { key: "symbols", label: "Sym", className: "wide" }, { key: "space", label: "Space", className: "extra-wide" }, { key: "enter", label: "Enter", className: "wide" },
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
    window.__wordCandidates = wordCandidates;

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
        // Re-attach the glide-trail canvas: innerHTML above wiped it out.
        ensureGlideTrailEl();
    }

    // Create the glide-trail canvas once and keep it as the last child of the
    // keyboard (above the keys, below the key preview). Idempotent.
    function ensureGlideTrailEl() {
        if (!touchKeyboardEl) {
            return;
        }
        if (!glideTrailEl) {
            glideTrailEl = document.createElement("canvas");
            glideTrailEl.id = "glide-trail";
            glideTrailEl.className = "hidden";
            glideTrailEl.setAttribute("aria-hidden", "true");
        }
        touchKeyboardEl.appendChild(glideTrailEl);
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

    // --- Glide trail overlay ---
    // A canvas the size of the keyboard, drawn on during a glide to trace the
    // finger's path. DPR-aware so the curve is crisp on retina screens.

    function sizeGlideTrail() {
        if (!glideTrailEl || !touchKeyboardEl) {
            return;
        }
        var dpr = window.devicePixelRatio || 1;
        var w = touchKeyboardEl.clientWidth;
        var h = touchKeyboardEl.clientHeight;
        glideTrailEl.width = Math.round(w * dpr);
        glideTrailEl.height = Math.round(h * dpr);
        var ctx = glideTrailEl.getContext("2d");
        // Reset any prior transform, then scale so we can draw in CSS pixels.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    function clearGlideTrail() {
        if (!glideTrailEl) {
            return;
        }
        var ctx = glideTrailEl.getContext("2d");
        // Clear in device pixels regardless of the current transform.
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, glideTrailEl.width, glideTrailEl.height);
        ctx.restore();
    }

    function hideGlideTrail() {
        glideTrailPoints = [];
        if (glideTrailEl) {
            clearGlideTrail();
            glideTrailEl.classList.add("hidden");
        }
        if (typeof window !== "undefined") {
            window.__glideTrailLen = 0;
        }
    }

    function startGlideTrail(x, y) {
        if (!glideTrailEl) {
            return;
        }
        glideTrailPoints = [{ x: x, y: y }];
        sizeGlideTrail();
        clearGlideTrail();
        glideTrailEl.classList.remove("hidden");
        if (typeof window !== "undefined") {
            window.__glideTrailLen = glideTrailPoints.length;
        }
    }

    function drawGlideTrail() {
        if (!glideTrailEl || glideTrailPoints.length === 0) {
            return;
        }
        var ctx = glideTrailEl.getContext("2d");
        clearGlideTrail();
        var pts = glideTrailPoints;
        if (pts.length === 1) {
            // A single point: draw a small dot so there's immediate feedback.
            ctx.beginPath();
            ctx.fillStyle = "rgba(96, 192, 255, 0.75)";
            ctx.arc(pts[0].x, pts[0].y, 3, 0, Math.PI * 2);
            ctx.fill();
            return;
        }
        ctx.lineWidth = 6;
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        ctx.strokeStyle = "rgba(96, 192, 255, 0.75)";
        ctx.shadowColor = "rgba(96, 192, 255, 0.55)";
        ctx.shadowBlur = 8;
        ctx.beginPath();
        ctx.moveTo(pts[0].x, pts[0].y);
        // Smooth the path with quadratic curves through the midpoints of each
        // pair of points (Catmull-Rom-ish), then finish to the last point.
        for (var i = 1; i < pts.length - 1; i++) {
            var midX = (pts[i].x + pts[i + 1].x) / 2;
            var midY = (pts[i].y + pts[i + 1].y) / 2;
            ctx.quadraticCurveTo(pts[i].x, pts[i].y, midX, midY);
        }
        var last = pts[pts.length - 1];
        ctx.lineTo(last.x, last.y);
        ctx.stroke();
        ctx.shadowBlur = 0;
    }

    function pushGlideTrailPoint(x, y) {
        if (!glideTrailEl || glideTrailPoints.length === 0) {
            return;
        }
        glideTrailPoints.push({ x: x, y: y });
        drawGlideTrail();
        if (typeof window !== "undefined") {
            window.__glideTrailLen = glideTrailPoints.length;
        }
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
            // Hiding the keyboard mid-hold must kill any typematic repeat, or
            // the interval keeps typing into the shell with no key on screen.
            if (kbdHoldTimer) {
                clearTimeout(kbdHoldTimer);
                kbdHoldTimer = null;
            }
            if (kbdRepeatTimer) {
                clearInterval(kbdRepeatTimer);
                kbdRepeatTimer = null;
            }
            kbdTouchId = null;
            kbdStartKey = null;
            kbdKeyFired = false;
            glidePath = [];
            gliding = false;
            hideTouchKeyPreview();
            hideGlideTrail();
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
                openSelectMode();
            }, 600);
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

        // --- Unified touch lifecycle (iOS) ---
        // The keyboard is driven by raw touch events rather than `click`.
        // `click` on iOS carries tap-delay and double-tap coalescing, which
        // caused typing lag, dropping the first of two fast keys, and flaky
        // glide. `touchend` fires immediately, so taps register instantly and
        // glide/typematic share one gesture pipeline.

        // Mode/modifier keys mutate the layout rather than emit output, so
        // repeating them makes no sense. Everything else (letters, digits,
        // punctuation, space/enter/backspace/escape/tab) is repeatable.
        function isRepeatableKey(keyName) {
            return keyName !== "shift" && keyName !== "symbols" && keyName !== "letters";
        }

        function clearKbdTimers() {
            if (kbdHoldTimer) {
                clearTimeout(kbdHoldTimer);
                kbdHoldTimer = null;
            }
            if (kbdRepeatTimer) {
                clearInterval(kbdRepeatTimer);
                kbdRepeatTimer = null;
            }
        }

        function resetKbdTouch() {
            clearKbdTimers();
            kbdTouchId = null;
            kbdStartKeyEl = null;
            kbdStartKey = null;
            kbdKeyFired = false;
            glidePath = [];
            gliding = false;
            hideGlideTrail();
        }

        function keyElAtPoint(x, y) {
            var el = document.elementFromPoint(x, y);
            return el && el.closest ? el.closest(".touch-key") : null;
        }

        touchKeyboardEl.addEventListener("touchstart", function (e) {
            // A second touch landing mid-press cancels the press (no
            // multitouch typing); single-touch only.
            if (!e.touches || e.touches.length !== 1) {
                resetKbdTouch();
                hideTouchKeyPreview();
                return;
            }
            var touch = e.changedTouches[0];
            var btn = e.target.closest ? e.target.closest(".touch-key") : null;
            if (!btn) {
                btn = keyElAtPoint(touch.clientX, touch.clientY);
            }
            if (!btn) {
                return;
            }
            // Passive-friendly: no preventDefault here so the gesture stays
            // smooth; the synthetic click is suppressed at touchend instead.
            var key = btn.getAttribute("data-touch-key");
            kbdTouchId = touch.identifier;
            kbdStartKeyEl = btn;
            kbdStartKey = key;
            kbdKeyFired = false;
            showTouchKeyPreview(btn);

            // Arm a glide when conditions are met.
            if (settings.glideTyping && autocompleteActive() && /^[a-z]$/.test(key)) {
                glidePath = [key];
                gliding = false;
                // Begin the finger-path trail at the touch's relative point.
                var startRect = touchKeyboardEl.getBoundingClientRect();
                startGlideTrail(touch.clientX - startRect.left, touch.clientY - startRect.top);
            } else {
                glidePath = [];
                gliding = false;
                hideGlideTrail();
            }

            // Typematic: after a hold, repeatedly fire the key. A moving
            // finger (glide) cancels this in touchmove.
            if (isRepeatableKey(key)) {
                kbdHoldTimer = setTimeout(function () {
                    kbdHoldTimer = null;
                    if (kbdTouchId === null || gliding) {
                        return;
                    }
                    handleTouchKeyboardAction(key);
                    kbdKeyFired = true;
                    kbdRepeatTimer = setInterval(function () {
                        // Belt-and-suspenders: if the press's touchend was ever
                        // missed/coalesced, never let keystrokes auto-fire forever.
                        if (kbdTouchId === null) {
                            clearKbdTimers();
                            return;
                        }
                        handleTouchKeyboardAction(key);
                    }, KBD_REPEAT_MS);
                }, KBD_HOLD_MS);
            }
        }, { passive: true });

        touchKeyboardEl.addEventListener("touchmove", function (e) {
            if (kbdTouchId === null) {
                return;
            }
            var touch = null;
            for (var i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === kbdTouchId) {
                    touch = e.changedTouches[i];
                    break;
                }
            }
            if (!touch) {
                return;
            }
            var btn = keyElAtPoint(touch.clientX, touch.clientY);
            var key = btn ? btn.getAttribute("data-touch-key") : null;

            // A moving finger is not a held key: as soon as it leaves the
            // start key (or all keys), cancel hold/typematic.
            if (key !== kbdStartKey) {
                clearKbdTimers();
            }

            // Trace the finger path whenever a glide is armed, even between
            // keys, so the trail stays smooth and continuous.
            if (glidePath.length && settings.glideTyping && autocompleteActive()) {
                var moveRect = touchKeyboardEl.getBoundingClientRect();
                pushGlideTrailPoint(touch.clientX - moveRect.left, touch.clientY - moveRect.top);
            }

            // Glide tracking.
            if (glidePath.length && settings.glideTyping && autocompleteActive() && key && /^[a-z]$/.test(key)) {
                if (key !== glidePath[glidePath.length - 1]) {
                    glidePath.push(key);
                    gliding = glidePath.length >= 2;
                    showTouchKeyPreview(btn);
                }
            }
        }, { passive: true });

        touchKeyboardEl.addEventListener("touchend", function (e) {
            if (kbdTouchId === null) {
                return;
            }
            var matched = false;
            for (var i = 0; i < e.changedTouches.length; i++) {
                if (e.changedTouches[i].identifier === kbdTouchId) {
                    matched = true;
                    break;
                }
            }
            if (!matched) {
                return;
            }
            clearKbdTimers();
            // Suppress the synthetic click that follows this touch.
            e.preventDefault();
            kbdSuppressClickUntil = Date.now() + 500;

            if (gliding) {
                // A real glide: surface candidates, do not emit a key.
                glideCandidatesList = glideCandidates(glidePath, window.GLIDE_WORDS || []);
                renderAutocomplete();
            } else if (!kbdKeyFired && kbdStartKey !== null) {
                // A plain tap. If typematic already fired (kbdKeyFired), the
                // key was emitted by the interval, so we must NOT emit again.
                handleTouchKeyboardAction(kbdStartKey);
            }
            resetKbdTouch();
            hideTouchKeyPreview();
        }, { passive: false });

        touchKeyboardEl.addEventListener("touchcancel", function () {
            resetKbdTouch();
            hideTouchKeyPreview();
        }, { passive: true });

        // Desktop-dev fallback only: a synthetic click types the key, but is
        // suppressed for 500ms after any touch so iOS never double-fires.
        touchKeyboardEl.addEventListener("click", function (e) {
            if (Date.now() < kbdSuppressClickUntil) {
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
            openSelectMode();
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

    // The navigation keys repeat while held (typematic), like the on-screen
    // keyboard keys. Toggles/actions (Esc, Tab, Ctrl, Sel, ...) do not.
    function isRepeatableBarButton(btn) {
        var key = btn.getAttribute("data-key");
        return key === "up" || key === "down" || key === "left" || key === "right" ||
            key === "pageup" || key === "pagedown";
    }

    function bindBarButton(btn) {
        var touchStartX = 0;
        var touchStartY = 0;
        var moved = false;
        var fired = false;          // typematic already emitted this press
        var holdTimer = null;
        var repeatTimer = null;
        var repeatable = isRepeatableBarButton(btn);

        function clearBarTimers() {
            if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
            if (repeatTimer) { clearInterval(repeatTimer); repeatTimer = null; }
        }

        btn.addEventListener("touchstart", function (e) {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            moved = false;
            fired = false;
            if (!repeatable) return;
            clearBarTimers();
            holdTimer = setTimeout(function () {
                holdTimer = null;
                if (moved) return;
                handleBtnAction(btn);
                fired = true;
                repeatTimer = setInterval(function () {
                    handleBtnAction(btn);
                }, KBD_REPEAT_MS);
            }, KBD_HOLD_MS);
        }, { passive: true });

        btn.addEventListener("touchmove", function (e) {
            var dx = Math.abs(e.touches[0].clientX - touchStartX);
            var dy = Math.abs(e.touches[0].clientY - touchStartY);
            if (dx > 10 || dy > 10) {
                moved = true;
                clearBarTimers();
            }
        }, { passive: true });

        btn.addEventListener("touchend", function (e) {
            clearBarTimers();
            var dx = Math.abs(e.changedTouches[0].clientX - touchStartX);
            var dy = Math.abs(e.changedTouches[0].clientY - touchStartY);
            if (dx > 10 || dy > 10) return; // was a scroll, not a tap
            e.preventDefault();
            if (fired) return; // typematic already handled this press
            handleBtnAction(btn);
        });

        btn.addEventListener("touchcancel", clearBarTimers);

        btn.addEventListener("click", function (e) {
            e.preventDefault();
            handleBtnAction(btn);
        });
    }

    // Render the configurable buttons (everything after the fixed settings
    // gear) from settings.buttonBar, in stored order, and bind each one.
    function renderButtonBar() {
        var scroll = document.getElementById("button-scroll");
        if (!scroll) {
            return;
        }
        var gear = document.getElementById("settings-btn");
        // Clear all children, then re-attach the gear first.
        while (scroll.firstChild) {
            scroll.removeChild(scroll.firstChild);
        }
        if (gear) {
            scroll.appendChild(gear);
        }
        var ids = settings.buttonBar || defaultBarButtonIds();
        for (var i = 0; i < ids.length; i++) {
            var def = barButtonById(ids[i]);
            if (!def) {
                continue;
            }
            var btn = document.createElement("button");
            btn.type = "button";
            btn.className = "bar-btn" + (def.cls ? " " + def.cls : "");
            if (def.elId) {
                btn.id = def.elId;
            }
            for (var attr in def.attrs) {
                if (Object.prototype.hasOwnProperty.call(def.attrs, attr)) {
                    btn.setAttribute(attr, def.attrs[attr]);
                }
            }
            btn.textContent = def.label;
            // Preserve a latched modifier's visual active state across re-renders
            // (e.g. toggling bar config while Ctrl/Meta is armed).
            var modName = def.attrs && def.attrs["data-modifier"];
            if (modName && modifiers[modName]) {
                btn.classList.add("active");
            }
            scroll.appendChild(btn);
            bindBarButton(btn);
        }
    }

    // The fixed settings gear keeps the same binding logic as the rest.
    (function () {
        var gear = document.getElementById("settings-btn");
        if (gear) {
            bindBarButton(gear);
        }
    })();

    renderButtonBar();

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
