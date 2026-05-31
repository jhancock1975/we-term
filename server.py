import asyncio
import fcntl
import json
import os
import pty
import signal
import struct
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


async def index_handler(request):
    return web.FileResponse(os.path.join(STATIC_DIR, "index.html"))


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


app = web.Application()
app.router.add_get("/ws", websocket_handler)
app.router.add_get("/", index_handler)
app.router.add_post("/upload", upload_handler)
app.router.add_static("/static", STATIC_DIR)

if __name__ == "__main__":
    host = os.environ.get("WETERM_HOST", "10.0.0.196")
    port = int(os.environ.get("WETERM_PORT", "9090"))
    web.run_app(app, host=host, port=port)
