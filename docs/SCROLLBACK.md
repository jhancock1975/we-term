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

## Scrolling back through full-screen apps (Claude Code, codex, …)

By default screen uses the **alternate screen** for full-screen apps, which has
no history — so copy mode "only shows the first visible line." Turn this on:

**Settings → "Full-screen app scrollback".**

This makes we-term manage a screenrc (`~/.we-term/screenrc`, pointed at via
`$SCREENRC`) that **sources your own `~/.screenrc`** and then forces
`altscreen off` plus a 50000-line scrollback. With it on, full-screen apps write
into screen's scrollback, so the **Scrl** button + PgUp/PgDn scroll back through
them. Trade-off: redraws are messier and vim/less leave their contents in
history instead of restoring the previous view.

It applies to **new** screen sessions — start a fresh `screen` after toggling.
Your existing `~/.screenrc` is preserved (it's sourced first; we only override
`altscreen`/`defscrollback`).

### Doing it by hand instead

If you'd rather not use the toggle, put this in `~/.screenrc`:

```
defscrollback 50000
compacthist on
altscreen off
termcapinfo xterm* ti@:te@
```

(Use `altscreen on` instead if you prefer vim/less to restore the previous
screen and don't need to scroll back through full-screen apps.)
