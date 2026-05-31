import asyncio
import fcntl
import json
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
