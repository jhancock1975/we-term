# Web Terminal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a web-based terminal that connects a browser to a real system shell via WebSockets.

**Architecture:** Python aiohttp server spawns a PTY with the user's shell on WebSocket connect, then bridges input/output bidirectionally. Frontend uses xterm.js from CDN for terminal emulation with resize support.

**Tech Stack:** Python 3.12, aiohttp, pty/os/fcntl (stdlib), xterm.js 5.x (CDN)

---

### Task 1: Project Setup

**Files:**
- Create: `requirements.txt`
- Create: `static/` directory

**Step 1: Create requirements.txt**

```
aiohttp>=3.9,<4
```

**Step 2: Create virtual environment and install**

Run:
```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

Expected: aiohttp installs successfully.

**Step 3: Create static directory**

Run:
```bash
mkdir -p static
```

**Step 4: Commit**

```bash
git add requirements.txt
git commit -m "feat: add project dependencies"
```

---

### Task 2: Backend — PTY WebSocket Server

**Files:**
- Create: `server.py`

**Step 1: Write server.py**

```python
import asyncio
import fcntl
import os
import pty
import signal
import struct
import termios

from aiohttp import web


async def websocket_handler(request):
    ws = web.WebSocketResponse()
    await ws.prepare(request)

    master_fd, slave_fd = pty.openpty()

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"

    pid = os.fork()
    if pid == 0:
        os.close(master_fd)
        os.setsid()
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        os.close(slave_fd)
        shell = os.environ.get("SHELL", "/bin/bash")
        os.execvpe(shell, [shell], env)

    os.close(slave_fd)

    loop = asyncio.get_event_loop()

    async def read_pty():
        try:
            while True:
                await asyncio.sleep(0)
                try:
                    data = await loop.run_in_executor(
                        None, os.read, master_fd, 4096
                    )
                    if not data:
                        break
                    await ws.send_bytes(data)
                except OSError:
                    break
        finally:
            if not ws.closed:
                await ws.close()

    read_task = asyncio.create_task(read_pty())

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                import json
                try:
                    payload = json.loads(msg.data)
                    if payload.get("type") == "resize":
                        cols = payload["cols"]
                        rows = payload["rows"]
                        winsize = struct.pack("HHHH", rows, cols, 0, 0)
                        fcntl.ioctl(master_fd, termios.TIOCSWINSZ, winsize)
                    elif payload.get("type") == "input":
                        os.write(master_fd, payload["data"].encode())
                except (json.JSONDecodeError, KeyError):
                    os.write(master_fd, msg.data.encode())
            elif msg.type == web.WSMsgType.BINARY:
                os.write(master_fd, msg.data)
            elif msg.type == web.WSMsgType.ERROR:
                break
    finally:
        read_task.cancel()
        try:
            os.kill(pid, signal.SIGTERM)
            os.waitpid(pid, 0)
        except (OSError, ChildProcessError):
            pass
        try:
            os.close(master_fd)
        except OSError:
            pass

    return ws


app = web.Application()
app.router.add_get("/ws", websocket_handler)
app.router.add_static("/", "static", show_index=True)

if __name__ == "__main__":
    web.run_app(app, host="127.0.0.1", port=9090)
```

**Step 2: Verify server starts**

Run:
```bash
source venv/bin/activate
timeout 3 python server.py || true
```

Expected: Server starts listening on 127.0.0.1:9090 (timeout kills it after 3s).

**Step 3: Commit**

```bash
git add server.py
git commit -m "feat: add PTY WebSocket server"
```

---

### Task 3: Frontend — HTML and CSS

**Files:**
- Create: `static/index.html`
- Create: `static/style.css`

**Step 1: Write static/index.html**

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>we-term</title>
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/css/xterm.css">
    <link rel="stylesheet" href="style.css">
</head>
<body>
    <div id="terminal"></div>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5/lib/xterm.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0/lib/addon-fit.js"></script>
    <script src="terminal.js"></script>
</body>
</html>
```

**Step 2: Write static/style.css**

```css
* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

html, body {
    height: 100%;
    width: 100%;
    overflow: hidden;
    background: #000;
}

#terminal {
    height: 100%;
    width: 100%;
}
```

**Step 3: Commit**

```bash
git add static/index.html static/style.css
git commit -m "feat: add HTML and CSS for terminal page"
```

---

### Task 4: Frontend — Terminal JavaScript

**Files:**
- Create: `static/terminal.js`

**Step 1: Write static/terminal.js**

```javascript
document.addEventListener("DOMContentLoaded", function () {
    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'Cascadia Code', 'Fira Code', 'Menlo', monospace",
        theme: {
            background: "#1e1e1e",
            foreground: "#d4d4d4",
        },
    });

    const fitAddon = new FitAddon.FitAddon();
    term.loadAddon(fitAddon);
    term.open(document.getElementById("terminal"));
    fitAddon.fit();

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(protocol + "//" + window.location.host + "/ws");
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
```

**Step 2: Commit**

```bash
git add static/terminal.js
git commit -m "feat: add terminal JavaScript with WebSocket and resize support"
```

---

### Task 5: Integration Test

**Step 1: Start the server**

Run:
```bash
source venv/bin/activate
python server.py &
SERVER_PID=$!
sleep 2
```

**Step 2: Verify HTTP serves the page**

Run:
```bash
curl -s http://127.0.0.1:9090/ | head -5
```

Expected: Should show the HTML page starting with `<!DOCTYPE html>`.

**Step 3: Verify WebSocket endpoint exists**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:9090/ws
```

Expected: Should return status code (likely 426 Upgrade Required, which confirms the endpoint exists).

**Step 4: Stop the server**

Run:
```bash
kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null
```

**Step 5: Final commit**

```bash
git add -A
git commit -m "feat: complete web terminal application"
```

---

## Running

```bash
source venv/bin/activate
python server.py
```

Then open http://127.0.0.1:9090 in a browser.
