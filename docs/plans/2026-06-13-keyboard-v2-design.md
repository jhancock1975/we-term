# Keyboard v2 — Design & Decisions

Date: 2026-06-13
Target device: **iPhone 17 Pro Max only** (iOS Safari). Other devices/browsers are
not a concern; Playwright `webkit` is the authoritative proxy.
Rollback point: git tag `kbd-v2-pre` (commit 01ff6a3). Branch: `feat/keyboard-v2`.

User worked autonomously per "just go until you are done" — design decisions below
were made without round-tripping; assumptions are documented.

## Requests → tasks

1. **Bigger Backspace + settings glyphs.** DONE (commit 73d42a5): `.touch-key[data-touch-key="backspace"]`
   22px, `#settings-btn` and `#keyboard-gear` 25px.

2. **Glide typing doesn't work on iPhone** + **typing lag (first of two rapid keys dropped)**
   + **typematic repeat on long-press of keyboard keys (every 0.5s)**.
   Root cause for lag/glide: keyboard keys activate on **`click`** (terminal.js ~1620), which on
   iOS carries the post-tap delay and double-tap coalescing; the button bar already uses `touchend`
   and feels fine. **Fix = rework keyboard input to touch events** (touchstart/touchmove/touchend),
   which simultaneously (a) removes the click delay → no dropped chars, (b) makes glide tracking
   reliable on iOS, (c) provides the press lifecycle for typematic repeat.
   - Activation: fire the key on `touchend` (tap) immediately; keep a `click` fallback for desktop
     guarded so it doesn't double-fire after touch.
   - Glide: track the path from `touchmove` via `document.elementFromPoint`; on `touchend` with
     ≥2 distinct letters, produce suggestions (unchanged matcher). Otherwise it's a tap.
   - Typematic: on `touchstart` over a key, after a 500ms initial hold, repeat the key every 500ms
     until `touchend`/`touchcancel` or the finger moves off the key (or a glide starts). Modifier/
     mode keys (shift, sym, letters) and glide gestures do NOT auto-repeat.
   - Tests: drive synthetic TouchEvents (dispatch in-page) since Playwright mouse won't fire touch.

3. **Move Esc to the button bar, right of Ctrl** + **make the top button bar configurable.**
   - Render the button bar from a config list instead of hard-coded HTML. Available buttons:
     Ctrl, Meta, Esc, Tab, Sel, Paste, PgUp, PgDn, Up, Down, Left, Right. The settings (gear)
     button is always present and not configurable.
   - Default order/visibility: Ctrl, Meta, **Esc**, Tab, Sel, Paste, PgUp, PgDn, Up, Down, Left, Right.
   - Remove Esc from the on-screen keyboard bottom row (it now lives in the bar).
   - Settings: a "Button bar" section with a checkbox per available button to show/hide it.
     Persist as `settings.buttonBar` (array of enabled ids, or map). Reordering is out of scope (YAGNI).

4. **Smarter command completion.** When the current token closely matches English words (by stem /
   lemmatized comparison), surface word candidates; otherwise use the existing command sources
   (history, COMMON_COMMANDS, server `/complete`). Implementation:
   - Bundle a compact Porter stemmer (pure JS, no deps).
   - Maintain a word list (reuse/extend `window.GLIDE_WORDS`).
   - When the current token is alphabetic: stem it, find word-list entries whose stem matches
     (prefix/stem-equal), rank by frequency, and include them. Blend with command sources: in
     command position (first token / after a space at start) command sources rank first; mid-prose
     word candidates rank first. Keep the bar capped (~12). Suggest-only, never auto-applied.

5. **Copy/select overlay text matches normal terminal rendering.** `#select-content` currently uses
   `line-height: 1.4`, `white-space: pre-wrap`, `word-break: break-all` — visibly different from xterm.
   Make it match the terminal: same font-size (14px) and font, `white-space: pre` (no arbitrary
   wrapping/word-break), tighter line-height matching xterm, horizontal scroll for long lines,
   same background/foreground. Verify the copied text is unchanged (only presentation).

## Constraints
- ES5 style in terminal.js (`var`, function declarations); reuse existing helpers; DRY/YAGNI.
- Don't break password mode or system-keyboard mode (gate via `autocompleteActive()` where relevant).
- webkit Playwright project must stay green; chromium secondary.
