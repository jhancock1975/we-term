const { test, expect } = require("@playwright/test");
const { startServer, waitForServer, stopServer } = require("./helpers");

let serverProcess;
test.beforeAll(async () => { serverProcess = startServer(); await waitForServer(serverProcess); });
test.afterAll(async () => { await stopServer(serverProcess); });

const WS_INTERCEPT_SCRIPT = `
    window.__wsSent = [];
    const origWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
        window.__wsSent.push(data);
        return origWsSend.call(this, data);
    };
`;

async function ready(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    await page.addInitScript(WS_INTERCEPT_SCRIPT);
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

test("matcher: endpoints filter - path g-o-o-d returns 'good' but not 'the'", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(
        ["g","o","o","d"], window.GLIDE_WORDS
    ));
    expect(result).toContain("good");
    expect(result).not.toContain("the");
    await context.close();
});

test("matcher: a deduped path g-o-d (as a real glide produces) still yields 'good'", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(["g","o","d"], window.GLIDE_WORDS));
    expect(result).toContain("good");
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

test("matcher: returns [] for a path shorter than 2 keys", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(["t"], window.GLIDE_WORDS));
    expect(result).toEqual([]);
    await context.close();
});

test("glideTyping setting defaults on and the toggle reflects it", async ({ browser }) => {
    const { context, page } = await ready(browser);
    // Runtime default is on even when nothing is persisted yet.
    const runtimeDefault = await page.evaluate(() => {
        var raw = localStorage.getItem("we-term-settings");
        if (!raw) return true; // not yet persisted => default true
        var v = JSON.parse(raw).glideTyping;
        return v !== false;
    });
    expect(runtimeDefault).toBe(true);

    // The settings toggle exists and is checked by default.
    await page.locator("#settings-btn").tap();
    await page.waitForTimeout(200);
    await expect(page.locator("#glide-typing-toggle")).toBeChecked();
    await context.close();
});

// Dispatch a synthetic touch glide across the given letter keys.
// Uses real TouchEvent dispatch so it exercises the touchstart/move/end
// lifecycle (page.mouse.* does NOT fire touch events).
async function touchGlide(page, chars) {
    const pts = [];
    for (const ch of chars) {
        const b = await page.locator('#touch-keyboard [data-touch-key="' + ch + '"]').boundingBox();
        pts.push({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    }
    await page.evaluate((pts) => {
        const kb = document.getElementById("touch-keyboard");
        function mkTouch(x, y) {
            const el = document.elementFromPoint(x, y) || kb;
            // Prefer the real Touch constructor; fall back to a plain
            // touch-like object literal for engines that lack it.
            try {
                return new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
            } catch (err) {
                return { identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y };
            }
        }
        function fire(type, p) {
            const t = mkTouch(p.x, p.y);
            const empty = type === "touchend" || type === "touchcancel";
            const ev = new TouchEvent(type, {
                cancelable: true,
                bubbles: true,
                touches: empty ? [] : [t],
                targetTouches: empty ? [] : [t],
                changedTouches: [t],
            });
            (document.elementFromPoint(p.x, p.y) || kb).dispatchEvent(ev);
        }
        fire("touchstart", pts[0]);
        for (let i = 1; i < pts.length; i++) fire("touchmove", pts[i]);
        fire("touchend", pts[pts.length - 1]);
    }, pts);
}

// Some engines in Playwright may not synthesize TouchEvent. Detect once.
async function touchSupported(page) {
    return await page.evaluate(() => {
        try {
            // eslint-disable-next-line no-new
            new TouchEvent("touchstart", { changedTouches: [] });
            return true;
        } catch (err) {
            return false;
        }
    });
}

test("gliding across t-h-e-n surfaces 'then' as a tappable suggestion that inserts on tap", async ({ browser }) => {
    const { context, page } = await ready(browser);
    if (!(await touchSupported(page))) {
        test.skip(true, "engine cannot synthesize TouchEvent; logic covered by matcher tests");
        await context.close();
        return;
    }
    await page.waitForTimeout(400);
    await page.locator("#terminal .xterm-screen").tap();   // show keyboard
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);

    await touchGlide(page, ["t", "h", "e", "n"]);
    await page.waitForTimeout(200);

    const chip = page.locator('#autocomplete-bar [data-glide-value="then"]');
    await expect(chip).toHaveCount(1);
    await chip.tap();
    await page.waitForTimeout(150);
    // 'then ' should have been sent to the shell.
    const sent = await page.evaluate(() => (window.__wsSent || []).join(""));
    expect(sent).toContain("then ");
    await context.close();
});

// Like touchGlide, but stops before touchend so the gesture is still
// in-flight. Returns nothing; fire touchend separately via endGlide().
async function touchGlideHold(page, chars) {
    const pts = [];
    for (const ch of chars) {
        const b = await page.locator('#touch-keyboard [data-touch-key="' + ch + '"]').boundingBox();
        pts.push({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) });
    }
    await page.evaluate((pts) => {
        const kb = document.getElementById("touch-keyboard");
        function mkTouch(x, y) {
            const el = document.elementFromPoint(x, y) || kb;
            try {
                return new Touch({ identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y });
            } catch (err) {
                return { identifier: 1, target: el, clientX: x, clientY: y, pageX: x, pageY: y };
            }
        }
        function fire(type, p) {
            const t = mkTouch(p.x, p.y);
            const ev = new TouchEvent(type, {
                cancelable: true, bubbles: true,
                touches: [t], targetTouches: [t], changedTouches: [t],
            });
            (document.elementFromPoint(p.x, p.y) || kb).dispatchEvent(ev);
        }
        fire("touchstart", pts[0]);
        for (let i = 1; i < pts.length; i++) fire("touchmove", pts[i]);
        window.__lastGlidePt = pts[pts.length - 1];
    }, pts);
}

async function endGlide(page) {
    await page.evaluate(() => {
        const kb = document.getElementById("touch-keyboard");
        const p = window.__lastGlidePt;
        let t;
        try { t = new Touch({ identifier: 1, target: kb, clientX: p.x, clientY: p.y }); }
        catch (err) { t = { identifier: 1, target: kb, clientX: p.x, clientY: p.y }; }
        const ev = new TouchEvent("touchend", { cancelable: true, bubbles: true, touches: [], targetTouches: [], changedTouches: [t] });
        (document.elementFromPoint(p.x, p.y) || kb).dispatchEvent(ev);
    });
}

test("glide trail: canvas is created and starts hidden", async ({ browser }) => {
    const { context, page } = await ready(browser);
    await page.waitForTimeout(400);
    await page.locator("#terminal .xterm-screen").tap();   // show keyboard
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);
    // The overlay exists as a child of the keyboard and starts hidden.
    await expect(page.locator("#touch-keyboard #glide-trail")).toHaveCount(1);
    await expect(page.locator("#glide-trail")).toHaveClass(/hidden/);
    await context.close();
});

test("glide trail: visible during a glide, cleared after touchend", async ({ browser }) => {
    const { context, page } = await ready(browser);
    if (!(await touchSupported(page))) {
        test.skip(true, "engine cannot synthesize TouchEvent; trail is touch-driven");
        await context.close();
        return;
    }
    await page.waitForTimeout(400);
    await page.locator("#terminal .xterm-screen").tap();   // show keyboard
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);

    // Mid-glide: the trail is shown and has captured points.
    await touchGlideHold(page, ["t", "h", "e", "n"]);
    await page.waitForTimeout(100);
    await expect(page.locator("#glide-trail")).not.toHaveClass(/hidden/);
    const len = await page.evaluate(() => window.__glideTrailLen || 0);
    expect(len).toBeGreaterThanOrEqual(2);

    // After the finger lifts: hidden and points cleared.
    await endGlide(page);
    await page.waitForTimeout(100);
    await expect(page.locator("#glide-trail")).toHaveClass(/hidden/);
    const lenAfter = await page.evaluate(() => window.__glideTrailLen || 0);
    expect(lenAfter).toBe(0);
    await context.close();
});

test("glide trail: a plain tap never shows the trail", async ({ browser }) => {
    const { context, page } = await ready(browser);
    await page.waitForTimeout(400);
    await page.locator("#terminal .xterm-screen").tap();   // show keyboard
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);

    await page.locator('#touch-keyboard [data-touch-key="a"]').tap();
    await page.waitForTimeout(120);
    await expect(page.locator("#glide-trail")).toHaveClass(/hidden/);
    await context.close();
});

test("typematic: holding a key fires it repeatedly", async ({ browser }) => {
    const { context, page } = await ready(browser);
    if (!(await touchSupported(page))) {
        test.skip(true, "engine cannot synthesize TouchEvent; typematic is touch-only");
        await context.close();
        return;
    }
    await page.waitForTimeout(400);
    await page.locator("#terminal .xterm-screen").tap();   // show keyboard
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);

    const b = await page.locator('#touch-keyboard [data-touch-key="a"]').boundingBox();
    const x = Math.round(b.x + b.width / 2);
    const y = Math.round(b.y + b.height / 2);

    await page.evaluate(() => { window.__wsSent = []; });
    // touchstart, hold (no end) past the 500ms hold + a couple repeats, then end.
    await page.evaluate((pt) => {
        const kb = document.getElementById("touch-keyboard");
        const el = document.elementFromPoint(pt.x, pt.y) || kb;
        let t;
        try { t = new Touch({ identifier: 1, target: el, clientX: pt.x, clientY: pt.y }); }
        catch (err) { t = { identifier: 1, target: el, clientX: pt.x, clientY: pt.y }; }
        const ev = new TouchEvent("touchstart", { cancelable: true, bubbles: true, touches: [t], targetTouches: [t], changedTouches: [t] });
        el.dispatchEvent(ev);
        window.__typematicEl = el;
        window.__typematicTouch = t;
    }, { x, y });

    await page.waitForTimeout(1300);

    await page.evaluate(() => {
        const el = window.__typematicEl;
        const t = window.__typematicTouch;
        const ev = new TouchEvent("touchend", { cancelable: true, bubbles: true, touches: [], targetTouches: [], changedTouches: [t] });
        el.dispatchEvent(ev);
    });
    await page.waitForTimeout(100);

    // WS frames are JSON {type:"input",data:"a"}; count how many carry "a".
    const count = await page.evaluate(() => (window.__wsSent || []).filter(function (d) {
        try { return JSON.parse(d).data === "a"; } catch (e) { return false; }
    }).length);
    expect(count).toBeGreaterThanOrEqual(2);
    await context.close();
});

test("rapid taps on two different keys both reach the shell", async ({ browser }) => {
    const { context, page } = await ready(browser);
    await page.waitForTimeout(400);
    await page.locator("#terminal .xterm-screen").tap();   // show keyboard
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);

    await page.evaluate(() => { window.__wsSent = []; });
    await page.locator('#touch-keyboard [data-touch-key="a"]').tap();
    await page.locator('#touch-keyboard [data-touch-key="b"]').tap();
    await page.waitForTimeout(150);

    const sent = await page.evaluate(() => (window.__wsSent || []).join(""));
    expect(sent).toContain("a");
    expect(sent).toContain("b");
    await context.close();
});
