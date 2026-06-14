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
    expect(enter.y - bksp.y).toBeGreaterThan(bksp.height * 1.5);
    await context.close();
});

test("Space is the widest key on its row", async ({ browser }) => {
    const { context, page } = await openKeyboard(browser);
    const space = await page.locator('#touch-keyboard [data-touch-key="space"]').boundingBox();
    const enter = await page.locator('#touch-keyboard [data-touch-key="enter"]').boundingBox();
    const sym = await page.locator('#touch-keyboard [data-touch-key="symbols"]').boundingBox();
    // Esc no longer lives on the keyboard (it moved to the button bar).
    await expect(page.locator('#touch-keyboard [data-touch-key="escape"]')).toHaveCount(0);
    expect(space.width).toBeGreaterThan(enter.width);
    expect(space.width).toBeGreaterThan(sym.width);
    await context.close();
});

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
