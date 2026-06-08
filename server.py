import asyncio
import fcntl
import hashlib
import json
import os
import pty
import signal
import struct
import subprocess
import termios
import time

from aiohttp import web

UPLOAD_DIR = os.path.join(os.path.expanduser("~"), "we-term-uploads")
os.makedirs(UPLOAD_DIR, exist_ok=True)


class PtySession:
    def __init__(self):
        self.master_fd = None
        self.pid = None
        self.ws = None
        self.read_task = None
        self.alive = False
        self.buffer = bytearray()
        self.max_buffer = 64 * 1024

    def spawn(self):
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
        self.master_fd = master_fd
        self.pid = pid
        self.alive = True
        self.read_task = asyncio.create_task(self._read_pty())

    def is_alive(self):
        if not self.alive or self.pid is None:
            return False
        try:
            result = os.waitpid(self.pid, os.WNOHANG)
            if result[0] != 0:
                self.alive = False
                return False
            return True
        except (OSError, ChildProcessError):
            self.alive = False
            return False

    async def attach(self, ws):
        self.ws = ws

        if self.buffer:
            await ws.send_bytes(bytes(self.buffer))
            self.buffer.clear()

    def detach(self):
        self.ws = None

    async def _read_pty(self):
        loop = asyncio.get_event_loop()
        try:
            while True:
                await asyncio.sleep(0)
                try:
                    data = await loop.run_in_executor(
                        None, os.read, self.master_fd, 4096
                    )
                    if not data:
                        break
                    if self.ws is not None and not self.ws.closed:
                        try:
                            await self.ws.send_bytes(data)
                        except (ConnectionError, OSError):
                            self.buffer.extend(data)
                            if len(self.buffer) > self.max_buffer:
                                self.buffer = self.buffer[-self.max_buffer:]
                    else:
                        self.buffer.extend(data)
                        if len(self.buffer) > self.max_buffer:
                            self.buffer = self.buffer[-self.max_buffer:]
                except OSError:
                    break
        finally:
            self.alive = False

    def write(self, data):
        if self.master_fd is not None:
            os.write(self.master_fd, data)

    def resize(self, cols, rows):
        if self.master_fd is not None:
            winsize = struct.pack("HHHH", rows, cols, 0, 0)
            fcntl.ioctl(self.master_fd, termios.TIOCSWINSZ, winsize)

    async def destroy(self):
        self.ws = None
        self.alive = False
        if self.read_task is not None:
            self.read_task.cancel()
            self.read_task = None
        if self.pid is not None:
            try:
                os.kill(self.pid, signal.SIGTERM)
            except OSError:
                pass
            loop = asyncio.get_event_loop()
            try:
                await loop.run_in_executor(None, os.waitpid, self.pid, 0)
            except (OSError, ChildProcessError):
                pass
            self.pid = None
        if self.master_fd is not None:
            try:
                os.close(self.master_fd)
            except OSError:
                pass
            self.master_fd = None


session = None


async def websocket_handler(request):
    global session

    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)

    if session is None or not session.is_alive():
        if session is not None:
            await session.destroy()
        session = PtySession()
        session.spawn()

    await session.attach(ws)

    try:
        async for msg in ws:
            if msg.type == web.WSMsgType.TEXT:
                try:
                    payload = json.loads(msg.data)
                    if payload.get("type") == "resize":
                        session.resize(payload["cols"], payload["rows"])
                    elif payload.get("type") == "input":
                        session.write(payload["data"].encode())
                except (json.JSONDecodeError, KeyError):
                    session.write(msg.data.encode())
            elif msg.type == web.WSMsgType.BINARY:
                session.write(msg.data)
            elif msg.type == web.WSMsgType.ERROR:
                break
    finally:
        session.detach()

    return ws


BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")


@web.middleware
async def no_cache_middleware(request, handler):
    response = await handler(request)
    if request.path == "/" or request.path.startswith("/static"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate"
    return response


def _asset_version(*filenames):
    """Short content hash of static assets, used to cache-bust their URLs.

    iOS Safari/WebKit (and Chrome on iOS) routinely serve subresources from
    cache without revalidating, ignoring our no-cache header. Appending a
    content-derived ?v= to the asset URL guarantees a changed file produces a
    changed URL the browser cannot serve stale.
    """
    digest = hashlib.sha1()
    for name in filenames:
        try:
            with open(os.path.join(STATIC_DIR, name), "rb") as f:
                digest.update(f.read())
        except OSError:
            pass
    return digest.hexdigest()[:12]


async def index_handler(request):
    with open(os.path.join(STATIC_DIR, "index.html"), "r", encoding="utf-8") as f:
        html = f.read()
    version = _asset_version("terminal.js", "style.css")
    html = html.replace("/static/terminal.js", "/static/terminal.js?v=" + version)
    html = html.replace("/static/style.css", "/static/style.css?v=" + version)
    return web.Response(text=html, content_type="text/html", charset="utf-8")


async def upload_handler(request):
    reader = await request.multipart()
    field = await reader.next()
    if field is None or field.name != "image":
        return web.json_response({"error": "no image field"}, status=400)

    content_type = field.headers.get("Content-Type", "image/png")
    ext_map = {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/bmp": ".bmp",
    }
    ext = ext_map.get(content_type, ".png")
    filename = "paste-{ts}{ext}".format(ts=int(time.time() * 1000), ext=ext)
    filepath = os.path.join(UPLOAD_DIR, filename)

    with open(filepath, "wb") as f:
        while True:
            chunk = await field.read_chunk()
            if not chunk:
                break
            f.write(chunk)

    return web.json_response({"path": filepath})


def _session_cwd():
    """Current working directory of the live shell, for path completion."""
    try:
        if session is not None and session.pid:
            return os.readlink("/proc/{pid}/cwd".format(pid=session.pid))
    except OSError:
        pass
    return os.path.expanduser("~")


def _run_compgen(mode, token, cwd):
    """Run bash compgen for command or file completion of `token`.

    The user-supplied token and cwd are passed via the environment (never
    interpolated into the script) so they cannot inject shell code.
    """
    if mode == "command":
        script = 'compgen -c -- "$WT_TOKEN" 2>/dev/null | sort -u | head -n 40'
    else:
        script = 'cd "$WT_CWD" 2>/dev/null && compgen -f -- "$WT_TOKEN" 2>/dev/null | sort -u | head -n 40'
    env = {
        "WT_TOKEN": token,
        "WT_CWD": cwd,
        "PATH": os.environ.get("PATH", "/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", "/"),
    }
    try:
        result = subprocess.run(
            ["bash", "-c", script],
            capture_output=True, text=True, timeout=2, env=env,
        )
        return [line for line in result.stdout.split("\n") if line][:20]
    except Exception:
        return []


async def complete_handler(request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    line = data.get("line", "")
    if not isinstance(line, str):
        line = ""

    # Complete the last whitespace-separated token. If there is a preceding
    # token, complete a file/path; otherwise complete a command name.
    if " " in line.rstrip():
        token = line[line.rfind(" ") + 1:]
        mode = "file"
    else:
        token = line.strip()
        mode = "command"
        if token == "":
            return web.json_response({"candidates": [], "token": token})

    candidates = _run_compgen(mode, token, _session_cwd())
    return web.json_response({"candidates": candidates, "token": token})


app = web.Application(middlewares=[no_cache_middleware])
app.router.add_get("/ws", websocket_handler)
app.router.add_get("/", index_handler)
app.router.add_post("/upload", upload_handler)
app.router.add_post("/complete", complete_handler)
app.router.add_static("/static", STATIC_DIR)

if __name__ == "__main__":
    host = os.environ.get("WETERM_HOST", "0.0.0.0")
    port = int(os.environ.get("WETERM_PORT", "9090"))
    web.run_app(app, host=host, port=port)
