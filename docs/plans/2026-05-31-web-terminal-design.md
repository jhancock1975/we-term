# Web Terminal Design

## Summary

A web-based terminal application that connects a browser to a real system shell via WebSockets. Single-user, localhost only, no authentication.

## Architecture

```
Browser (xterm.js) ←→ WebSocket ←→ Python (aiohttp) ←→ PTY (bash/zsh)
```

**Frontend:** Single HTML page loading xterm.js and xterm-addon-fit from CDN. Connects via WebSocket on page load. Sends keystrokes and resize events to the server. Renders all PTY output.

**Backend:** Python `aiohttp` server serving static files over HTTP and handling WebSocket connections. Spawns a PTY with the user's default shell on each WebSocket connection. Bridges WebSocket ↔ PTY bidirectionally with async loops.

## Files

- `server.py` — aiohttp server, PTY management, WebSocket bridge
- `static/index.html` — HTML page with xterm.js container
- `static/style.css` — Terminal styling (full viewport, dark background)
- `static/terminal.js` — WebSocket connection, xterm.js setup, resize handling

## Features

- Full PTY: colors, cursor control, alternate screen buffer, signals, job control
- Terminal resize sync via TIOCSWINSZ ioctl
- Clean lifecycle: shell exit closes WebSocket, WebSocket close kills shell
- Port: 9090

## Dependencies

- **Frontend:** xterm.js + xterm-addon-fit (CDN)
- **Backend:** aiohttp (pip)
