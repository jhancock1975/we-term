# Scrolling back through history in we-term

Full-screen terminal apps (Claude Code, codex, `pi`, vim, less, htop, …) switch
the terminal into the **alternate screen buffer**. That buffer has **no
scrollback** — so the browser/xterm.js view is "stuck" on the current screen and
PgUp/PgDn or touch-scroll won't page through earlier output. This is true in any
real terminal, not just we-term.

When you run those apps inside **GNU screen** (the common case), the real history
lives in **screen's own copy/scrollback mode**, not in xterm.js.

## Using it from we-term

1. Tap **Scrl** in the button bar — it sends `Ctrl-A [`, entering screen's
   copy/scrollback mode.
2. Use **PgUp / PgDn** and the **arrow** buttons to scroll back through history.
3. Tap **Esc** to leave copy mode and return to the live view.

The **Scrl** button is part of the configurable button bar (Settings → Button
bar), so you can hide it if you don't use screen.

## Recommended `~/.screenrc`

screen's default scrollback is only 100 lines. Bump it and keep the alternate
screen enabled (so vim/less still behave):

```
defscrollback 50000
compacthist on
altscreen on
```

### Advanced: force full-screen output into the outer scrollback

If you'd rather have full-screen app output land in xterm.js's own scrollback
(so browser scroll works), disable the alternate screen. Trade-off: vim/less
leave their contents behind in history instead of restoring the previous view.

```
defscrollback 50000
compacthist on
altscreen off
termcapinfo xterm* ti@:te@
```
