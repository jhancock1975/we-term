# Touch Keyboard Redesign + Glide Typing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the on-screen touch keyboard easier to hit (bigger keys, no Tab/Space and Enter/Backspace adjacency traps) and add English glide ("swipe") typing that offers guesses as tappable suggestions.

**Architecture:** All client-side in `static/`. Phase 1 changes the key layout in `getTouchKeyboardRows()` (terminal.js) and the `.touch-key` sizing in style.css. Phase 2 adds glide detection inside the existing keyboard pointer handlers, a bundled English word-frequency list, a path→word matcher, and routes guesses into the existing autocomplete suggestion bar (suggest-only, never auto-typed). Gated by a new `glideTyping` setting.

**Tech Stack:** Vanilla JS (ES5 style to match the file), CSS, Playwright tests (`npx playwright test`), Python aiohttp server (unchanged).

**Design doc:** `docs/plans/2026-06-13-keyboard-redesign-design.md`

**Rollback point:** git tag `keyboard-pre-redesign` (commit 8915038). Branch: `feat/keyboard-redesign`.

**Reference patterns in the code:**
- Layout source: `static/terminal.js` `getTouchKeyboardRows()` (~line 1179).
- Key CSS: `static/style.css` `.touch-key` (~line 193), `#touch-keyboard` (~line 173).
- Pointer/preview handlers: `static/terminal.js` ~lines 1537-1561.
- Autocomplete bar: `static/terminal.js` ~lines 803-1018 (`renderAutocomplete`, `applyAutocomplete`, `buildItems`).
- Settings pattern: `autocompleteToggle` wiring (terminal.js ~lines 55, 258, and the `change` listener), defaults at line 5, HTML toggle in `static/index.html` ~line 33.
- Test setup pattern: `tests/autocomplete.spec.js` (`newTouchPage`, `gotoReady`, `typeViaKeys`).

Run all tests with: `npx playwright test`. Run one spec: `npx playwright test tests/<file>.spec.js --reporter=list`.

---

## PHASE 1 — Layout + sizing

### Task 1: New key layout in letters mode

**Files:**
- Modify: `static/terminal.js` `getTouchKeyboardRows()` (~line 1199-1216, the non-symbol return).
- Test: `tests/keyboard-layout.spec.js` (create).

**Target letters-mode layout** (data-touch-key values in parentheses):
- Row 1: `1 2 3 4 5 6 7 8 9 0`
- Row 2: `q w e r t y u i o p` then **Backspace** (`backspace`, wide)
- Row 3: `a s d f g h j k l -`
- Row 4: **Shift** (wide) `z x c v b n m . ,`
- Row 5: **Sym** (wide) **Esc** (`escape`) **Space** (extra-wide) **Enter** (wide)

Removed from letters mode: the `Esc` key from row 1 (moves to row 5), `Tab` from the bottom row (it lives in the button bar), and `/` from row 4 (stays in the Sym layer). `-` stays on row 3 (useful for flags; keeps existing tests that type `_` valid).

**Step 1: Write the failing test**

Create `tests/keyboard-layout.spec.js`:

```javascript
const { test, expect } = require("@playwright/test");
const { startServer, waitForServer, stopServer } = require("./helpers");

let serverProcess;
test.beforeAll(async () => { serverProcess = startServer(); await waitForServer(serverProcess); });
test.afterAll(async () => { await stopServer(serverProcess); });

async function openKeyboard(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);
    return { context, page };
}

test("Tab is not a key on the keyboard (it lives in the button bar)", async ({ browser }) => {
    const { context, page } = await openKeyboard(browser);
    await expect(page.locator('#touch-keyboard [data-touch-key="tab"]')).toHaveCount(0);
    await context.close();
});

test("Backspace and Enter are far apart (different rows, not stacked)", async ({ browser }) => {
    const { context, page } = await openKeyboard(browser);
    const bksp = await page.locator('#touch-keyboard [data-touch-key="backspace"]').boundingBox();
    const enter = await page.locator('#touch-keyboard [data-touch-key="enter"]').boundingBox();
    // Enter is on the bottom row, backspace well above it.
    expect(enter.y - bksp.y).toBeGreaterThan(bksp.height * 1.5);
    await context.close();
});

test("Space is the widest key on its row", async ({ browser }) => {
    const { context, page } = await openKeyboard(browser);
    const space = await page.locator('#touch-keyboard [data-touch-key="space"]').boundingBox();
    const enter = await page.locator('#touch-keyboard [data-touch-key="enter"]').boundingBox();
    const esc = await page.locator('#touch-keyboard [data-touch-key="escape"]').boundingBox();
    expect(space.width).toBeGreaterThan(enter.width);
    expect(space.width).toBeGreaterThan(esc.width);
    await context.close();
});
```

**Step 2: Run test to verify it fails**

Run: `npx playwright test tests/keyboard-layout.spec.js --reporter=list`
Expected: FAIL — Tab key still present; Esc/Space not where asserted.

**Step 3: Edit the layout**

Replace the non-symbol `return [...]` in `getTouchKeyboardRows()` with:

```javascript
return [
    [
        { char: "1", shiftChar: "!" }, { char: "2", shiftChar: "@" }, { char: "3", shiftChar: "#" }, { char: "4", shiftChar: "$" }, { char: "5", shiftChar: "%" }, { char: "6", shiftChar: "^" }, { char: "7", shiftChar: "&" }, { char: "8", shiftChar: "*" }, { char: "9", shiftChar: "(" }, { char: "0", shiftChar: ")" },
    ],
    [
        { char: "q" }, { char: "w" }, { char: "e" }, { char: "r" }, { char: "t" }, { char: "y" }, { char: "u" }, { char: "i" }, { char: "o" }, { char: "p" }, { key: "backspace", label: "⌫", className: "wide" },
    ],
    [
        { char: "a" }, { char: "s" }, { char: "d" }, { char: "f" }, { char: "g" }, { char: "h" }, { char: "j" }, { char: "k" }, { char: "l" }, { char: "-", shiftChar: "_" },
    ],
    [
        { key: "shift", label: "⇧", className: "wide" }, { char: "z" }, { char: "x" }, { char: "c" }, { char: "v" }, { char: "b" }, { char: "n" }, { char: "m" }, { char: "." , shiftChar: ">" }, { char: "," , shiftChar: "<" },
    ],
    [
        { key: "symbols", label: "Sym", className: "wide" }, { key: "escape", label: "Esc" }, { key: "space", label: "Space", className: "extra-wide" }, { key: "enter", label: "Enter", className: "wide" },
    ],
];
```

Also update the **symbol-mode** bottom row (same function, ~line 1195) to drop `Tab` for consistency (Tab is in the button bar):

```javascript
[
    { key: "letters", label: "ABC", className: "wide" }, { key: "escape", label: "Esc" }, { key: "space", label: "Space", className: "extra-wide" }, { key: "enter", label: "Enter", className: "wide" },
],
```
(Remove the separate `escape` from the symbol top row if it now duplicates; keep one Esc reachable. Leave the rest of symbol mode as-is.)

**Step 4: Run test to verify it passes**

Run: `npx playwright test tests/keyboard-layout.spec.js --reporter=list`
Expected: PASS (all 3).

**Step 5: Commit**

```bash
git add static/terminal.js tests/keyboard-layout.spec.js
git commit -m "Keyboard: new layout - Bksp top-right, Enter bottom, no Tab key, wide Space"
```

---

### Task 2: Bigger keys (CSS sizing)

**Files:**
- Modify: `static/style.css` `.touch-key` (~line 193), `.touch-keyboard-row` (~line 187).
- Test: add to `tests/keyboard-layout.spec.js`.

**Step 1: Write the failing test**

Append to `tests/keyboard-layout.spec.js`:

```javascript
test("Every key meets the 44px minimum touch height", async ({ browser }) => {
    const { context, page } = await openKeyboard(browser);
    const heights = await page.locator("#touch-keyboard .touch-key").evaluateAll(
        (els) => els.map((e) => e.getBoundingClientRect().height)
    );
    expect(heights.length).toBeGreaterThan(20);
    for (const h of heights) {
        expect(h).toBeGreaterThanOrEqual(44);
    }
    await context.close();
});
```

**Step 2: Run to verify it fails**

Run: `npx playwright test tests/keyboard-layout.spec.js --reporter=list -g "44px"`
Expected: FAIL — current keys are ~38px tall (`padding: 12px 0`, `line-height: 1`, 14px font).

**Step 3: Edit CSS**

In `.touch-key`, raise the touch target and font:
```css
.touch-key {
    flex: 1 1 0;
    min-width: 0;
    min-height: 46px;
    padding: 14px 0;
    /* ...unchanged: background, color, border, etc... */
    font-size: 16px;
}
```
In `.touch-keyboard-row`, widen the gap slightly so neighbours are less likely to be hit:
```css
.touch-keyboard-row {
    display: flex;
    gap: 5px;
    justify-content: center;
}
```
Keep `#touch-keyboard` `gap: 5px` to match. (Adjust the `46px`/`padding` only if the keyboard overflows short viewports — verify in Task 3 manual check.)

**Step 4: Run to verify it passes**

Run: `npx playwright test tests/keyboard-layout.spec.js --reporter=list`
Expected: PASS (all 4).

**Step 5: Commit**

```bash
git add static/style.css tests/keyboard-layout.spec.js
git commit -m "Keyboard: larger keys (>=46px touch targets, bigger gaps and font)"
```

---

### Task 3: Fix regressions in existing specs

**Files:**
- Modify: any of `tests/*.spec.js` that assume the old layout.
- Verify only — no app change unless a test reveals a real break.

**Step 1: Run the full suite**

Run: `npx playwright test --reporter=list`
Expected: most pass; failures only where a spec depended on the OLD layout (e.g. a test that taps `[data-touch-key="tab"]` on the keyboard, or expected Esc on the top row).

**Step 2: Fix each failing assertion to match the new layout**

For any spec that tapped the keyboard's Tab key, switch to the button-bar Tab (`#button-bar [data-key="tab"]`) or remove if redundant. Do NOT weaken a test to make it pass — update it to the new, correct layout. `-`, `space`, `enter`, `backspace`, `shift`, and all letters keep the same `data-touch-key`, so most specs are unaffected.

**Step 3: Re-run the full suite**

Run: `npx playwright test --reporter=list`
Expected: all green (clipboard tests still skip on WebKit as before).

**Step 4: Manual check (real viewport)**

Use the `verify` skill (or `run` skill) to load the app in a phone-sized viewport and confirm the keyboard fits without clipping the terminal and keys look roomy.

**Step 5: Commit**

```bash
git add tests/
git commit -m "Tests: update specs for new keyboard layout"
```

---

## PHASE 2 — Glide typing

### Task 4: Bundle the English word list

**Files:**
- Create: `static/glide-words.js`
- Modify: `static/index.html` (load the script before `terminal.js`).

**Step 1: Create the word-list asset**

`static/glide-words.js` defines a global frequency-ordered array (most common first). Start with a representative list; the full ~10k list is dropped in here later without code changes.

```javascript
// Frequency-ordered English words for glide typing. Most common first.
// Lowercase, letters only. Replaceable with a larger list; no code depends
// on its length.
window.GLIDE_WORDS = [
    "the","and","you","that","was","for","are","with","his","they",
    "this","have","from","one","had","word","but","not","what","all",
    "were","when","your","can","said","there","use","each","which","she",
    "how","their","will","other","about","out","many","then","them","these",
    "some","her","would","make","like","him","into","time","has","look",
    "two","more","write","see","number","way","could","people","than","first",
    "water","been","call","who","its","now","find","long","down","day",
    "did","get","come","made","may","part","over","new","sound","take",
    "only","little","work","know","place","year","live","back","give","most",
    "very","after","thing","our","just","name","good","sentence","man","think",
    "say","great","where","help","through","much","before","line","right","too",
    "mean","old","any","same","tell","boy","follow","came","want","show",
    "also","around","form","three","small","set","put","end","does","another",
    "well","large","must","big","even","such","because","turn","here","why",
    "ask","went","men","read","need","land","different","home","move","try",
    "kind","hand","picture","again","change","off","play","spell","air","away",
    "animal","house","point","page","letter","mother","answer","found","study","still",
    "learn","should","world","high","every","near","add","food","between","own",
];
```

**Step 2: Load it in index.html**

In `static/index.html`, before `<script src="/static/terminal.js"></script>`, add:
```html
<script src="/static/glide-words.js"></script>
```

**Step 3: Verify it loads**

Run: `npx playwright test tests/smoke.spec.js --reporter=list` (still green) and confirm no 404 — add a quick check or just eyeball the network in the verify step later.

**Step 4: Commit**

```bash
git add static/glide-words.js static/index.html
git commit -m "Glide: bundle English word-frequency list asset"
```

---

### Task 5: Path → word matcher (pure function, unit-tested in the browser)

**Files:**
- Modify: `static/terminal.js` (add `glideCandidates(pathKeys, words)` near the keyboard helpers, ~after `getTouchKeyOutput`).
- Test: `tests/glide.spec.js` (create) — exercises the function via `page.evaluate`.

**Algorithm (heuristic):** Given `pathKeys` (ordered, de-duplicated letters the finger crossed) return up to 3 words where:
- the word starts with `pathKeys[0]` and ends with the last path key (endpoints are the strongest signal in glide typing), and
- every letter of the word appears, in order, as a subsequence of `pathKeys` (the path must pass over each letter), and
- ranked by the word's frequency rank (its index in the list — lower is better), tie-broken by closeness of word length to path length.

Expose it on `window` for testing.

**Step 1: Write the failing test**

Create `tests/glide.spec.js`:

```javascript
const { test, expect } = require("@playwright/test");
const { startServer, waitForServer, stopServer } = require("./helpers");

let serverProcess;
test.beforeAll(async () => { serverProcess = startServer(); await waitForServer(serverProcess); });
test.afterAll(async () => { await stopServer(serverProcess); });

async function ready(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(400);
    return { context, page };
}

test("matcher: a path through t-h-e-n yields 'then' as a top candidate", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(
        ["t","h","e","n"], window.GLIDE_WORDS
    ));
    expect(result).toContain("then");
    await context.close();
});

test("matcher: endpoints filter - path g..o does not return 'the'", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(
        ["g","o","o","d"], window.GLIDE_WORDS
    ));
    expect(result).toContain("good");
    expect(result).not.toContain("the");
    await context.close();
});

test("matcher: returns at most 3 candidates", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(
        ["t","h","e","r","e"], window.GLIDE_WORDS
    ));
    expect(result.length).toBeLessThanOrEqual(3);
    await context.close();
});
```

**Step 2: Run to verify it fails**

Run: `npx playwright test tests/glide.spec.js --reporter=list`
Expected: FAIL — `window.__glideCandidates` is undefined.

**Step 3: Implement the matcher**

In `static/terminal.js`, add (and expose for tests):

```javascript
// Glide typing: map an ordered list of crossed keys to up to 3 dictionary
// words. A glide word starts and ends at the path endpoints and its letters
// appear in order somewhere along the path. Ranked by frequency (list order).
function glideCandidates(pathKeys, words) {
    if (!pathKeys || pathKeys.length < 2 || !words || !words.length) {
        return [];
    }
    var first = pathKeys[0];
    var last = pathKeys[pathKeys.length - 1];
    var pathLen = pathKeys.length;
    var scored = [];
    for (var w = 0; w < words.length; w++) {
        var word = words[w];
        if (word.length < 2) continue;
        if (word[0] !== first || word[word.length - 1] !== last) continue;
        // Is the word an ordered subsequence of the path?
        var pi = 0;
        for (var ci = 0; ci < word.length && pi < pathKeys.length; ci++) {
            while (pi < pathKeys.length && pathKeys[pi] !== word[ci]) pi++;
            if (pi < pathKeys.length) pi++;
        }
        var matched = (pi <= pathKeys.length) && isSubsequence(word, pathKeys);
        if (!matched) continue;
        // Lower score is better: frequency rank + length mismatch penalty.
        var score = w + Math.abs(word.length - pathLen) * 50;
        scored.push({ word: word, score: score });
    }
    scored.sort(function (a, b) { return a.score - b.score; });
    return scored.slice(0, 3).map(function (s) { return s.word; });
}

function isSubsequence(word, pathKeys) {
    var pi = 0;
    for (var ci = 0; ci < word.length; ci++) {
        while (pi < pathKeys.length && pathKeys[pi] !== word[ci]) pi++;
        if (pi >= pathKeys.length) return false;
        pi++;
    }
    return true;
}

// Exposed for tests.
window.__glideCandidates = glideCandidates;
```
(The duplicate inline subsequence loop above is redundant with `isSubsequence`; keep only `isSubsequence` — simplify the body to call it directly.)

**Step 4: Run to verify it passes**

Run: `npx playwright test tests/glide.spec.js --reporter=list`
Expected: PASS (all 3).

**Step 5: Commit**

```bash
git add static/terminal.js tests/glide.spec.js
git commit -m "Glide: path-to-word matcher (endpoint + subsequence + frequency)"
```

---

### Task 6: The `glideTyping` setting

**Files:**
- Modify: `static/terminal.js` defaults (line 5), parse block (~line 13), `applySettings`/restore (~line 258), add toggle var + `change` listener (mirror `autocompleteToggle`).
- Modify: `static/index.html` add a `glide-typing-toggle` checkbox in the settings sheet (mirror the autocomplete option ~line 33) and a Help bullet.
- Test: `tests/glide.spec.js` add a setting-default check.

**Step 1: Write the failing test**

Append to `tests/glide.spec.js`:

```javascript
test("glideTyping setting defaults on and persists", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const def = await page.evaluate(() => {
        var raw = localStorage.getItem("we-term-settings");
        return raw ? JSON.parse(raw).glideTyping : "unset";
    });
    // Either explicitly true or unset (defaults to true at runtime).
    expect(def === true || def === "unset").toBeTruthy();
    await context.close();
});
```

**Step 2: Run to verify it fails / passes trivially**

Run: `npx playwright test tests/glide.spec.js --reporter=list -g "glideTyping setting"`
Expected: PASS only after the default exists; if it fails, the default wiring is missing.

**Step 3: Wire the setting**

- Defaults (line 5): add `glideTyping: true`.
- Parse block (~line 13): add `glideTyping: parsed.glideTyping !== false,`.
- Add `var glideTypingToggle = document.getElementById("glide-typing-toggle");` with the others (~line 55).
- In the restore/apply path (~line 258, next to autocomplete): `if (glideTypingToggle) { glideTypingToggle.checked = settings.glideTyping; }`.
- Add a `change` listener mirroring `autocompleteToggle`'s: set `settings.glideTyping`, `saveSettings()`.
- In `static/index.html`, after the autocomplete option:
```html
<label class="settings-option" for="glide-typing-toggle">
    <span>Glide typing</span>
    <input id="glide-typing-toggle" type="checkbox">
</label>
```
- Add a Help bullet near the completion bullet (~line 73): "**Glide typing** — drag across the letters to glide-type a word; tap a suggestion to insert it."

**Step 4: Run to verify it passes**

Run: `npx playwright test tests/glide.spec.js --reporter=list`
Expected: PASS.

**Step 5: Commit**

```bash
git add static/terminal.js static/index.html tests/glide.spec.js
git commit -m "Glide: add glideTyping setting (default on) + Help text"
```

---

### Task 7: Glide gesture detection + suggestion-bar integration

**Files:**
- Modify: `static/terminal.js` keyboard pointer handlers (~lines 1537-1561), `renderAutocomplete` (~line 994), the bar click handler (~line 1035), and add `applyGlideWord`.
- Test: `tests/glide.spec.js` add an end-to-end gesture test.

**Behaviour:**
- Track a glide while a pointer is down on the keyboard: on `pointermove`, resolve the key under the finger via `document.elementFromPoint`; if it is a letter key (`data-touch-key` is a single a-z char) and differs from the last recorded key, push it onto `glidePath`. Update the key preview to the current key.
- If `glidePath.length >= 2` at `pointerup`, it's a glide: compute `glideCandidates(glidePath, window.GLIDE_WORDS)`, store them, suppress the upcoming `click` (so no single key is typed), and `renderAutocomplete()` to show them.
- Glide only runs when `settings.glideTyping && autocompleteActive()` (so it's off in password mode / when disabled / system-keyboard mode).
- Glide chips render in the existing bar with `data-glide-value`. Tapping one calls `applyGlideWord(word)` → `sendInput(word + " ")` (append at cursor; do NOT erase currentLine the way `applyAutocomplete` does). Clear `glideCandidates` after a tap and on the next real keystroke (in `trackAutocompleteInput`).

**Step 1: Write the failing test**

Append to `tests/glide.spec.js` (synthesize a path with raw pointer events over the rendered keys):

```javascript
test("gliding across t-h-e-n surfaces 'then' as a tappable suggestion", async ({ browser }) => {
    const { context, page } = await ready(browser);
    await page.waitForTimeout(400);
    await page.locator("#terminal .xterm-screen").tap();      // show keyboard
    await page.waitForTimeout(300);

    async function centre(ch) {
        const b = await page.locator('#touch-keyboard [data-touch-key="' + ch + '"]').boundingBox();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    const pts = [];
    for (const ch of ["t", "h", "e", "n"]) pts.push(await centre(ch));

    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down();
    for (const p of pts.slice(1)) {
        await page.mouse.move(p.x, p.y, { steps: 6 });
    }
    await page.mouse.up();
    await page.waitForTimeout(150);

    const chip = page.locator('#autocomplete-bar [data-glide-value="then"]');
    await expect(chip).toHaveCount(1);
    await context.close();
});
```

(Note: pointer events are emulated via mouse in Playwright with `hasTouch`; if the handlers are `pointer*` this drives them. If flaky, dispatch synthetic `pointermove` events in `page.evaluate` instead.)

**Step 2: Run to verify it fails**

Run: `npx playwright test tests/glide.spec.js --reporter=list -g "gliding across"`
Expected: FAIL — no glide handling yet, no glide chip.

**Step 3: Implement detection + rendering**

Add state near the other keyboard vars: `var glidePath = []; var gliding = false; var glideCandidatesList = []; var glideSuppressClickUntil = 0;`.

In the keyboard `pointerdown` handler, when starting on a letter key, reset: `glidePath = [letterChar]; gliding = false;` (only if `settings.glideTyping && autocompleteActive()`).

Add a `pointermove` listener on `touchKeyboardEl`:
```javascript
touchKeyboardEl.addEventListener("pointermove", function (e) {
    if (!glidePath.length || !settings.glideTyping || !autocompleteActive()) return;
    var el = document.elementFromPoint(e.clientX, e.clientY);
    var btn = el && el.closest ? el.closest(".touch-key") : null;
    if (!btn) return;
    var k = btn.getAttribute("data-touch-key");
    if (!/^[a-z]$/.test(k)) return;              // letters only
    if (k !== glidePath[glidePath.length - 1]) {
        glidePath.push(k);
        gliding = glidePath.length >= 2;
        showTouchKeyPreview(btn);
    }
});
```

In `pointerup` (extend the existing `hideTouchKeyPreview` handler into a function):
```javascript
touchKeyboardEl.addEventListener("pointerup", function () {
    if (gliding) {
        glideCandidatesList = glideCandidates(glidePath, window.GLIDE_WORDS || []);
        glideSuppressClickUntil = Date.now() + 500;   // swallow the click
        renderAutocomplete();
    }
    glidePath = [];
    gliding = false;
    hideTouchKeyPreview();
});
```

In the keyboard `click` handler (~line 1537), bail if a glide just finished:
```javascript
if (Date.now() < glideSuppressClickUntil) { e.preventDefault(); return; }
```

In `renderAutocomplete`, before building normal items, show glide candidates if present:
```javascript
if (glideCandidatesList.length) {
    autocompleteBar.innerHTML = glideCandidatesList.map(function (w) {
        return '<button class="ac-chip ac-glide" type="button" data-glide-value="' + escapeHtml(w) + '">' + escapeHtml(w) + "</button>";
    }).join("");
    setAutocompleteVisible(true);
    return;
}
```

Clear glide candidates on the next real keystroke — at the top of `trackAutocompleteInput` add: `if (glideCandidatesList.length) { glideCandidatesList = []; }`.

Add `applyGlideWord` and route taps. In the bar's click/tap handler (~line 1035 where it reads `data-ac-value`), also handle glide chips:
```javascript
var glideVal = chip.getAttribute("data-glide-value");
if (glideVal !== null) {
    glideCandidatesList = [];
    sendInput(glideVal + " ");
    triggerHapticFeedback();
    renderAutocomplete();
    return;
}
```

**Step 4: Run to verify it passes**

Run: `npx playwright test tests/glide.spec.js --reporter=list`
Expected: PASS (all glide tests).

**Step 5: Run full suite (no regressions)**

Run: `npx playwright test --reporter=list`
Expected: all green; tapping single keys still types one char (existing autocomplete/cursor specs prove this).

**Step 6: Commit**

```bash
git add static/terminal.js tests/glide.spec.js
git commit -m "Glide: gesture detection + tappable suggestions in the bar"
```

---

### Task 8: Real-device verification + optional larger dictionary

**Files:** none (verification), optionally `static/glide-words.js`.

**Step 1:** Use the `verify` (or `run`) skill to open the app on a touch/phone viewport. Confirm:
- Keys feel bigger; Tab no longer between things; Space large; Enter and Backspace far apart.
- Dragging across letters shows a path preview and produces suggestions; tapping one inserts the word + space; ignoring it types nothing.
- Single taps still type single characters; password prompts show no suggestions.

**Step 2 (optional):** Drop a larger frequency-ordered list into `static/glide-words.js` (no code change). Re-run `npx playwright test tests/glide.spec.js`.

**Step 3:** Final full run: `npx playwright test --reporter=list`. All green.

**Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch to merge or open a PR. The rollback tag `keyboard-pre-redesign` remains as the pre-change reference.

---

## Notes for the executor

- Match the file's existing **ES5 style** (`var`, function declarations) — no `let`/`const`/arrow functions in `static/terminal.js`.
- DRY: reuse `showTouchKeyPreview`, `renderAutocomplete`, `sendInput`, `triggerHapticFeedback`, `escapeHtml` — don't reimplement.
- YAGNI: no English autocorrect-on-insert, no multi-word glide, no path-trail canvas (key-highlight preview is enough).
- Glide is **suggest-only** — never auto-send a guessed word.
- Don't weaken existing tests to make them pass; update them to the new layout's truth.
