document.addEventListener("DOMContentLoaded", function () {
    var term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'Cascadia Code', 'Fira Code', 'Menlo', monospace",
        theme: {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
        },
    });

    var fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById("terminal"));
    fitAddon.fit();

    var protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(protocol + "//" + window.location.host + "/ws");
    ws.binaryType = "arraybuffer";

    ws.addEventListener("open", function () {
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
        term.write("\r\n\r\n[Connection closed]\r\n");
    });

    term.onData(function (data) {
        if (ws.readyState === WebSocket.OPEN) {
            var payload = JSON.stringify({ type: "input", data: data });
            ws.send(payload);
        }
    });

    function sendResize() {
        if (ws.readyState === WebSocket.OPEN) {
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

    function sendInput(data) {
        if (ws.readyState === WebSocket.OPEN) {
            var payload = JSON.stringify({ type: "input", data: data });
            ws.send(payload);
        }
    }

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

    document.querySelectorAll(".bar-btn").forEach(function (btn) {
        btn.addEventListener("touchstart", function (e) {
            e.preventDefault();
        });

        btn.addEventListener("click", function (e) {
            e.preventDefault();
            var mod = btn.getAttribute("data-modifier");
            if (mod) {
                modifiers[mod] = !modifiers[mod];
                btn.classList.toggle("active", modifiers[mod]);
                term.focus();
                return;
            }

            var key = btn.getAttribute("data-key");
            if (key && keyMap[key] !== undefined) {
                var seq = applyModifiers(keyMap[key]);
                sendInput(seq);
            }
            term.focus();
        });
    });

    // --- Keyboard visibility detection ---

    var keyboardVisible = false;

    function updateBarPosition() {
        if (window.visualViewport) {
            var viewportHeight = window.visualViewport.height;
            var fullHeight = window.innerHeight;
            var keyboardNow = fullHeight - viewportHeight > 100;

            if (keyboardNow !== keyboardVisible) {
                keyboardVisible = keyboardNow;
                enterBtn.style.display = keyboardVisible ? "none" : "";
            }

            if (keyboardVisible) {
                var offset = fullHeight - viewportHeight;
                buttonBar.style.position = "fixed";
                buttonBar.style.bottom = offset + "px";
                buttonBar.style.left = "0";
                buttonBar.style.right = "0";
            } else {
                buttonBar.style.position = "";
                buttonBar.style.bottom = "";
                buttonBar.style.left = "";
                buttonBar.style.right = "";
            }

            doFit();
        }
    }

    if (window.visualViewport) {
        window.visualViewport.addEventListener("resize", updateBarPosition);
        window.visualViewport.addEventListener("scroll", updateBarPosition);
    }

    updateBarPosition();
});
