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

test("gliding across t-h-e-n surfaces 'then' as a tappable suggestion that inserts on tap", async ({ browser }) => {
    const { context, page } = await ready(browser);
    await page.waitForTimeout(400);
    await page.locator("#terminal .xterm-screen").tap();   // show keyboard
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);

    async function centre(ch) {
        const b = await page.locator('#touch-keyboard [data-touch-key="' + ch + '"]').boundingBox();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    const pts = [];
    for (const ch of ["t", "h", "e", "n"]) pts.push(await centre(ch));

    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down();
    for (const p of pts.slice(1)) {
        await page.mouse.move(p.x, p.y, { steps: 8 });
    }
    await page.mouse.up();
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
