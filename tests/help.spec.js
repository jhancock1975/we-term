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

async function newTouchPage(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    return { context: context, page: page };
}

async function gotoReady(page) {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(800);
}

test("Settings button shows a gear icon", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    var label = await page.locator("#settings-btn").textContent();
    expect(label.trim()).toBe("⚙"); // ⚙

    await result.context.close();
});

test("Help opens a full-screen page with an X close button and explains the app", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    // Open settings, then Help.
    await page.locator("#settings-btn").tap();
    await expect(page.locator("#settings-panel")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await expect(page.locator("#help-btn")).toBeVisible();

    await page.locator("#help-btn").tap();

    // Full-screen help shown, settings closed.
    await expect(page.locator("#help-overlay")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await expect(page.locator("#settings-panel")).toHaveClass(/hidden/);

    // X close button is present in the upper-right.
    var close = page.locator("#help-close-btn");
    await expect(close).toBeVisible();
    var box = await close.boundingBox();
    var vw = page.viewportSize();
    expect(box.x + box.width).toBeGreaterThan(vw.width / 2);
    expect(box.y).toBeLessThan(vw.height / 2);

    // Content explains how to use the app.
    var text = await page.locator("#help-content").textContent();
    expect(text.toLowerCase()).toContain("how to use");
    expect(text.toLowerCase()).toContain("system keyboard");
    expect(text.toLowerCase()).toContain("copy");

    // X closes it.
    await close.tap();
    await expect(page.locator("#help-overlay")).toHaveClass(/hidden/, { timeout: 2000 });

    await result.context.close();
});
