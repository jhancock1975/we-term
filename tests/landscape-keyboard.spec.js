const { test, expect } = require("@playwright/test");
const { startServer, waitForServer, stopServer } = require("./helpers");

let serverProcess;

test.beforeAll(async () => {
    serverProcess = startServer();
    await waitForServer(serverProcess);
});

test.afterAll(async () => {
    await stopServer(serverProcess);
});

test("In landscape, the on-screen keyboard uses at most half the viewport", async ({ browser }) => {
    // A phone in landscape: wide and short.
    var context = await browser.newContext({ hasTouch: true, viewport: { width: 900, height: 410 } });
    var page = await context.newPage();

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.locator("#terminal .xterm-screen").tap(); // show keyboard
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);

    var viewport = page.viewportSize();
    var kb = await page.locator("#touch-keyboard").boundingBox();
    // Keyboard occupies at most half the viewport height (small tolerance).
    expect(kb.height).toBeLessThanOrEqual(viewport.height * 0.5 + 2);

    // Critically: the keyboard's BOTTOM must not run past the viewport (the old
    // bug let non-shrinking rows overflow the cap and cover the terminal).
    expect(kb.y + kb.height).toBeLessThanOrEqual(viewport.height + 2);

    // The actual key cells must also fit within the keyboard box (no spill).
    var lastKey = await page.locator("#touch-keyboard .touch-key").last().boundingBox();
    expect(lastKey.y + lastKey.height).toBeLessThanOrEqual(kb.y + kb.height + 2);

    // The terminal stays visible above it.
    var term = await page.locator("#terminal").boundingBox();
    expect(term.height).toBeGreaterThan(40);

    // Keys are still rendered (not collapsed away).
    var keyCount = await page.locator("#touch-keyboard .touch-key").count();
    expect(keyCount).toBeGreaterThan(20);

    await context.close();
});

test("In portrait, the keyboard keeps full-size keys", async ({ browser }) => {
    var context = await browser.newContext({ hasTouch: true, viewport: { width: 410, height: 900 } });
    var page = await context.newPage();

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(300);

    // Portrait has room: keys stay at the full >=44px touch target.
    var h = await page.locator('#touch-keyboard [data-touch-key="a"]').boundingBox();
    expect(h.height).toBeGreaterThanOrEqual(44);

    await context.close();
});
