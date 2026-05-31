document.addEventListener("DOMContentLoaded", function () {
    var term = new Terminal({
        cursorBlink: true,
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

    // --- Select overlay ---

    var selectOverlay = document.getElementById("select-overlay");
    var selectContent = document.getElementById("select-content");
    var selectDoneBtn = document.getElementById("select-done-btn");

    function openSelectMode() {
        var lines = [];
        var buffer = term.buffer.active;
        for (var i = 0; i <= buffer.length - 1; i++) {
            var line = buffer.getLine(i);
            if (line) {
                lines.push(line.translateToString(true));
            }
        }
        selectContent.textContent = lines.join("\n");
        selectOverlay.classList.remove("hidden");
    }

    function closeSelectMode() {
        selectOverlay.classList.add("hidden");
        selectContent.textContent = "";
        term.focus();
    }

    selectDoneBtn.addEventListener("click", closeSelectMode);

    // --- Paste overlay ---

    var pasteOverlay = document.getElementById("paste-overlay");
    var pasteArea = document.getElementById("paste-area");
    var pasteSendBtn = document.getElementById("paste-send-btn");
    var pasteCancelBtn = document.getElementById("paste-cancel-btn");

    function openPasteMode() {
        pasteArea.value = "";
        pasteOverlay.classList.remove("hidden");
        pasteArea.focus();
    }

    function closePasteMode() {
        pasteOverlay.classList.add("hidden");
        pasteArea.value = "";
        term.focus();
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
                term.focus();
            })
            .catch(function () {
                showToast("Upload failed");
                term.focus();
            });
    }

    // Handle paste events directly on the terminal (desktop Ctrl+V)
    var termEl = document.getElementById("terminal");

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
    var enterBtn = document.getElementById("enter-btn");
    var buttonBar = document.getElementById("button-bar");

    var keyMap = {
        up: "\x1b[A",
        down: "\x1b[B",
        right: "\x1b[C",
        left: "\x1b[D",
        pageup: "\x1b[5~",
        pagedown: "\x1b[6~",
        enter: "\r",
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

    function handleBtnAction(btn) {
        var mod = btn.getAttribute("data-modifier");
        if (mod) {
            modifiers[mod] = !modifiers[mod];
            btn.classList.toggle("active", modifiers[mod]);
            term.focus();
            return;
        }

        var action = btn.getAttribute("data-action");
        if (action === "select") {
            openSelectMode();
            return;
        }
        if (action === "paste") {
            openPasteMode();
            return;
        }

        var key = btn.getAttribute("data-key");
        if (key && keyMap[key] !== undefined) {
            var seq = applyModifiers(keyMap[key]);
            sendInput(seq);
        }
        term.focus();
    }

    document.querySelectorAll(".bar-btn").forEach(function (btn) {
        btn.addEventListener("touchstart", function (e) {
            e.preventDefault();
        });

        btn.addEventListener("touchend", function (e) {
            e.preventDefault();
            handleBtnAction(btn);
        });

        btn.addEventListener("click", function (e) {
            e.preventDefault();
            handleBtnAction(btn);
        });
    });

    // --- Keyboard visibility detection + terminal resize ---

    var keyboardVisible = false;

    function updateLayout() {
        if (window.visualViewport) {
            var vpHeight = window.visualViewport.height;
            var vpOffsetTop = window.visualViewport.offsetTop;
            var fullHeight = window.innerHeight;
            var keyboardNow = fullHeight - vpHeight > 100;

            if (keyboardNow !== keyboardVisible) {
                keyboardVisible = keyboardNow;
                enterBtn.style.display = keyboardVisible ? "none" : "";
            }

            // Scroll the page to top so terminal starts at screen top
            window.scrollTo(0, 0);

            if (keyboardVisible) {
                // Resize everything to fit within the visual viewport
                var barHeight = buttonBar.offsetHeight;
                var availableHeight = vpHeight - barHeight;

                document.body.style.height = vpHeight + "px";
                termEl.style.height = availableHeight + "px";
                termEl.style.flex = "none";

                buttonBar.style.position = "";
                buttonBar.style.bottom = "";
                buttonBar.style.left = "";
                buttonBar.style.right = "";
            } else {
                document.body.style.height = "";
                termEl.style.height = "";
                termEl.style.flex = "";

                buttonBar.style.position = "";
                buttonBar.style.bottom = "";
                buttonBar.style.left = "";
                buttonBar.style.right = "";
            }

            doFit();
        }
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", updateLayout);
        window.visualViewport.addEventListener("scroll", updateLayout);
    }

    updateLayout();
});
