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
        var payload = JSON.stringify({
            type: "resize",
            cols: term.cols,
            rows: term.rows,
        });
        ws.send(payload);
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

    window.addEventListener("resize", function () {
        fitAddon.fit();
        if (ws.readyState === WebSocket.OPEN) {
            var payload = JSON.stringify({
                type: "resize",
                cols: term.cols,
                rows: term.rows,
            });
            ws.send(payload);
        }
    });
});
