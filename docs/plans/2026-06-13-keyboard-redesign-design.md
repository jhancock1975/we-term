# Touch Keyboard Redesign + Glide Typing — Design

Date: 2026-06-13
Status: Approved (brainstorm)

## Problem

The on-screen touch keyboard has ergonomic problems on a phone:

- **Keys are too small.** Every key is `flex: 1 1 0` with `padding: 12px 0`,
  so 10–11 keys split the screen width. Adjacent letters are easy to hit by
  mistake.
- **Tab sits immediately left of Space** on the bottom row
  (`Sym Tab Space Enter`), so reaching for Space lands on Tab.
- **Backspace and Enter are stacked in the bottom-right corner**
  (Backspace = far right of the Shift row, Enter = far right of the bottom
  row), so reaching for Backspace hits Enter.

Additionally, the user wants a way to **type by dragging a finger across the
keys** (glide / swipe typing).

## Goals

1. Bigger, easier-to-hit keys.
2. Eliminate the Tab/Space and Enter/Backspace adjacency traps.
3. Add English glide typing that surfaces guesses as tappable suggestions
   (never auto-typed) and coexists with normal tapping.
4. Keep today's keyboard recoverable via git in case the redesign regresses.

## Decisions

- **Glide vocabulary:** English dictionary (user's explicit choice), accepting
  that it will not guess shell tokens (commands, flags, paths). Tapping still
  handles those. Glide is additive, for prose (commit messages, notes, vim).
- **Glide commit model:** suggest-don't-insert. Guesses appear in the existing
  autocomplete suggestion bar as tappable chips. A wrong guess costs nothing.
- **Rollback:** git only. A branch/tag is created at the current commit
  (`8915038`) before work begins. No second layout maintained in the product
  and no user-facing layout toggle.

## Section 1 — New key layout

```
Current (cramped)              Proposed (roomy)
─────────────────────         ─────────────────────────
Esc 1 2 3 4 5 6 7 8 9 0       1 2 3 4 5 6 7 8 9 0
q w e r t y u i o p           q  w  e  r  t  y  u  i  o  p   ⌫Bksp
a s d f g h j k l -           a  s  d  f  g  h  j  k  l
Shift z x c v b n m . / Bksp  ⇧Shift  z  x  c  v  b  n  m   .  ,
Sym Tab [Space] Enter         Sym  Esc  [    Space    ]  ⏎Enter
```

- **Backspace** moves to the top-right (end of the `q…p` row); **Enter** stays
  bottom-right. They are now a full keyboard-height apart.
- **Tab is removed from the keyboard** — it already exists in the button bar
  above (`<button data-key="tab">Tab</button>`). **Space** becomes the
  dominant bottom key, no longer wedged against Tab. **Esc** moves down beside
  Sym so the top row stays purely numeric and wide.
- Fewer keys per row + taller keys + bigger gaps → larger touch targets.
  Target ~44px+ tall keys (Apple minimum touch target).
- `-`, `/` and similar punctuation move into the Sym layer / are repositioned
  so the letter rows stay roomy.

Implementation touches `getTouchKeyboardRows()` (layout) and the
`#touch-keyboard` / `.touch-key` CSS in `static/style.css` (sizing).

## Section 2 — Glide typing mechanics

Implemented inside the existing keyboard pointer handlers in
`static/terminal.js`.

1. **Tap vs glide detection.** `pointerdown` on a key starts tracking (as the
   preview already does). `pointermove` records the key under the finger. On
   `pointerup`:
   - Finger stayed on/near one key → **tap** (existing behavior, unchanged).
   - Finger crossed several keys → **glide**: collect the ordered list of keys
     the path crossed.
2. **Path → word candidates.** A bundled English word-frequency list
   (~10k common words, shipped as a static asset, loaded once). A lightweight
   matcher scores words by: first letter ≈ first key, last letter ≈ last key,
   the word's letters appearing in order near the traced path, weighted by word
   frequency. Returns the top 3.
3. **Surfacing results.** The 3 candidates appear in the existing autocomplete
   suggestion bar as tappable chips. Tap → inserts `word` + a trailing space.
   No tap → nothing happens. Glide candidates transiently own the bar until the
   next keystroke, then normal history/shell autocomplete resumes.
4. **Visual feedback.** During the glide, the key under the finger highlights
   (reusing the current preview highlight) so the path is visible.
5. **Setting.** A new `glideTyping` setting in the settings panel alongside
   `autocomplete`, so glide can be turned off (it shares the suggestion bar).

**Honest limits:** the matcher is a heuristic; accuracy on a small keyboard is
modest, and it only knows English words. Gliding shell tokens won't produce
useful guesses, but tapping still works and the suggest-don't-insert model
means a bad guess costs nothing.

## Section 3 — Testing & rollout

Playwright (`tests/*.spec.js`).

- **Layout tests** (extend keyboard/button-bar specs): assert new positions
  (Backspace at end of `q…p` row, no Tab key on the keyboard, Space widest
  bottom key, Enter bottom-right); assert each key's rendered height meets the
  ~44px minimum; confirm each key still emits the correct sequence on tap.
- **Glide tests** (new spec): synthesize a pointer path
  (`pointerdown` → several `pointermove`s → `pointerup`); assert the suggestion
  bar shows expected candidates; tapping a candidate inserts `word `; a single
  key press still types one character; glide respects `glideTyping` = off.
- **Regression:** existing keyboard specs stay green; some will be updated for
  the new layout (expected).

### Phases

- **Phase 1 — Layout + sizing.** Bigger keys, Tab/Space and Enter/Backspace
  fixes, CSS. Small, high-value, low-risk; ships first.
- **Phase 2 — Glide typing.** Dictionary asset, path matcher, suggestion-bar
  integration, `glideTyping` setting.

Both phases land on the feature branch; the branch/tag at the current commit is
the rollback point throughout.
