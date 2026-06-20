# we-term SSH mode + GitHub Pages hosting — Design

Date: 2026-06-20
Status: Design (not yet implemented)
Target device: iPhone 17 Pro Max / iOS Safari (Chrome on iOS).

This design was developed in consultation with ChatGPT. Each decision below is
tagged **[agree]** where I adopt ChatGPT's recommendation, **[diverge]** where I
deviate and why, so the reasoning is auditable.

## Goal

Host the static frontend on **GitHub Pages**, and add an **SSH mode**: the user
enters an SSH host + key in we-term settings and gets the existing xterm.js +
on-screen-keyboard UI connected to a remote SSH server.

## Current architecture (what we're changing)

- `server.py` (aiohttp) holds **one global `PtySession`**: a single local bash
  via `pty.openpty()` + `fork()`, streamed as raw bytes over a single `/ws`.
  Reconnects re-attach to that shared session.
- **No auth at all** — bound to `0.0.0.0:9090`, a personal LAN tool.
- Endpoints: `GET /ws`, `GET /` (serves index.html), `POST /complete`,
  `GET /history`, `POST /upload`. Frontend = static files, no build step.
- Control protocol already uses **binary frames for terminal bytes** and **JSON
  text frames for control** (e.g. `{"type":"hidden"}`, `{"type":"resize"}`,
  `{"type":"input"}`).

Exposing this to the internet unchanged would be catastrophic (an open,
unauthenticated shell). The redesign is as much a **hardening** as a feature.

## Decisions

### 1. Session model — registry, not a global session **[agree]**
Replace the single global `PtySession` with a `SessionRegistry` of
`TerminalSession` objects keyed by an unguessable id, each owning its own
PTY/SSH channel, cols/rows, and attached WebSockets. Subclasses
`LocalPtySession` and `SshPtySession` share a base (`write`, `resize`,
`broadcast_bytes`, `broadcast_json`, `close`).

Reconnect becomes **explicit**: the client stores `session_id` and sends
`{"type":"attach","session_id":...}`; the server only re-attaches if the
session's `owner_id` matches the caller's. **No more implicit global re-attach**
— that's safe on a LAN but unacceptable once exposed.

Add an **idle reaper** (close sessions after N minutes idle) and a max lifetime.
**[diverge/extend]** ChatGPT mentioned `reap_idle`; I make it mandatory, not
optional — a persisted SSH connection sitting open after the browser is gone is
both a resource leak and a security exposure.

### 2. One backend, explicit modes **[agree]**
Local-shell and SSH coexist behind one backend; the user picks the mode. One
`/ws` endpoint; the first client text frame is `open` (`mode: "local" | "ssh"`)
or `attach`. Control protocol (extends what we already have):

- client→server: `open`, `attach`, `stdin`, `resize`, `close`, `trust_host`
- server→client: `status` (`connecting_ssh`/`connected`/`attached`),
  `error` (with a `code`), `pending_hostkey`; terminal output stays **binary**.

Keep the existing `{"type":"hidden"}` message. Keep `stdin` as JSON for now;
optionally move typed input to binary later for latency.

### 3. Auth — password → short-lived ticket **[agree]**
Minimum viable, and required before any PTY/SSH traffic:
- `POST /auth/login` with a pre-shared admin password (env
  `WETERM_ADMIN_PASSWORD`), compared with `hmac.compare_digest`, **rate-limited
  by IP**.
- Returns a single-use, ~60s **ticket**. Client opens `GET /ws?ticket=...`.
- Rationale: browser `WebSocket` can't set `Authorization` headers; cross-site
  cookies from a Pages origin are unreliable on iOS; the long-term secret never
  rides in the WS URL (only the short-lived ticket does).
- Enforce an **Origin allowlist** on `/ws` and CORS on the fetch endpoints.
  **[diverge/clarify]** Origin is a *courtesy*, not a security boundary
  (non-browser clients forge it); the ticket is the real gate. Document that.
- **[diverge/extend]** When deployed via a tunnel, put the provider's access
  control (e.g. Cloudflare Access) *in front* of this — defense in depth.

### 4. Key handling — per-session, memory-only for v1 **[agree, with planned follow-up]**
v1: user pastes the **private** key (and optional passphrase) into settings; it's
kept in JS memory, sent in the `open` message over **wss**, parsed by the
backend in memory, never written to disk or `localStorage`, and dereferenced
after connect. (Python strings can't be truly zeroed — documented limitation.)
Frames containing keys must **never be logged**.

**[diverge]** ChatGPT picked per-session paste and dismissed backend-stored keys.
I agree for v1's *safety*, but pasting a full private key on a *phone every
session* is genuinely painful — so the protocol will be designed so a future
**backend key store referenced by name** (option b) drops in cleanly as a
usability follow-up, with its tradeoff documented (backend compromise = key
compromise). Also carry forward ChatGPT's earlier advice: use a **dedicated,
restricted SSH key** (`from=...,no-port-forwarding,no-agent-forwarding` in the
server's `authorized_keys`), never your laptop key.

### 5. SSH library — AsyncSSH **[agree]**
We're already asyncio; AsyncSSH gives in-memory keys, PTY resize
(`create_process(term_type=..., term_size=...)`, `change_terminal_size`),
host-key validation hooks, and avoids temp key files / subprocess lifecycle.
No shelling out to `/usr/bin/ssh`.

### 6. Transport / TLS **[agree on recommendation; honor user's choice as supported fallback]**
- **Recommended:** **Cloudflare Tunnel** (`cloudflared`) → local aiohttp on
  loopback. Valid HTTPS/WSS, no router forwarding, optional Cloudflare Access,
  no home-IP/cert renewal pain.
- **User's chosen path (supported, documented):** the user is OK forwarding a
  port. **[diverge]** Use **Caddy on standard 443** with a real domain + DDNS
  (Caddy auto-provisions/renews Let's Encrypt) reverse-proxying to aiohttp on
  127.0.0.1 — far simpler than ACME on a nonstandard port. If they truly want
  **9375**, Caddy can serve TLS on `:9375`, but 80/443 may still be needed for
  ACME challenges; document that wrinkle.
- **Hard rule:** **wss only.** A GitHub Pages (HTTPS) origin talking to
  `ws://home-ip:9375` is mixed-content and will be blocked / is insecure.

### 7. Host-key verification — TOFU with explicit approval **[agree]**
App-owned `~/.we-term/known_hosts`. Unknown host → `ssh-keyscan` the key,
send `pending_hostkey` (type + SHA256 fingerprint), user confirms, append, retry.
Known+matching → connect. Known+**changed** → block with a scary
`host_key_changed` error; require manual reset via a protected
`/known-hosts` endpoint. Never `known_hosts=None`. Document that TOFU still
trusts a first-connection MITM — advise out-of-band fingerprint comparison.

### 8. Existing endpoints **[agree]**
`/complete`, `/history`, `/upload` assume the local filesystem. For v1 they work
for **local** sessions only and are **disabled in SSH mode** (don't fake remote
history/completion). All of them get protected by the same ticket/auth.
Later: SFTP upload + remote `history` over the same AsyncSSH connection.

### 9. Frontend settings **[agree]**
Persist only safe fields in `localStorage`: backend URL, mode, ssh host/port/
username, maybe `lastSessionId`. **Never** persist private key, passphrase, admin
password, or ticket.

## Security checklist (must-haves before exposing)
- wss only; Origin allowlist on `/ws`; CORS on fetch endpoints.
- Password→ticket auth, constant-time compare, IP rate-limit on `/auth/login`.
- No request-body/frame logging (keys, stdin).
- Per-session keys in memory only; never persisted.
- TOFU host-key verification; block on key change.
- Idle + max-lifetime session reaping.
- Dedicated restricted SSH key recommended in docs.
- aiohttp bound to loopback behind the tunnel/Caddy; run as unprivileged user.
- Prefer a tunnel with its own access layer over raw port-forwarding.

## Phased implementation plan
1. `SessionRegistry` + `LocalPtySession`; keep current behavior working.
2. `/ws` requires `open`/`attach`; explicit reconnect by `session_id`.
3. Password→ticket auth + Origin/CORS enforcement; protect all endpoints.
4. Frontend: backend-URL + login UI; store/restore `session_id`.
5. Deploy behind Cloudflare Tunnel (or Caddy/443/wss).
6. `SshPtySession` via AsyncSSH (in-memory key, PTY resize).
7. TOFU `pending_hostkey` / `trust_host` flow + `~/.we-term/known_hosts`.
8. Disable `/complete` `/history` `/upload` for SSH sessions.
9. (Follow-up) Backend key store referenced by name; SFTP upload in SSH mode.

## Open questions for implementation time
- Exact AsyncSSH resize call name on the installed version
  (`change_terminal_size` vs channel API) — verify against the pinned version.
- Whether to keep local-shell mode at all once SSH exists, or make the local box
  itself an SSH target (uniform path). Leaning: keep both; local is useful and
  already works.
