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

const WS_INTERCEPT_SCRIPT = `
    window.__wsSent = [];
    const origWsSend = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
        window.__wsSent.push(data);
        return origWsSend.call(this, data);
    };
`;

function getInputs(messages) {
    return messages
        .map((m) => { try { return JSON.parse(m); } catch (e) { return null; } })
        .filter((m) => m && m.type === "input");
}

test("Ctrl+C via mouse click sends \\x03", async ({ page }) => {
    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => window.__wsSent.length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator("#terminal .xterm-screen").click();
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__wsSent = []; });

    var ctrlBtn = page.locator('[data-modifier="ctrl"]');
    await ctrlBtn.click();
    await expect(ctrlBtn).toHaveClass(/active/, { timeout: 2000 });

    await page.keyboard.press("c");
    await page.waitForTimeout(500);

    var messages = await page.evaluate(() => window.__wsSent);
    var inputs = getInputs(messages);
    console.log("Ctrl+C inputs:", JSON.stringify(inputs));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[inputs.length - 1].data).toBe("\x03");

    await expect(ctrlBtn).not.toHaveClass(/active/, { timeout: 2000 });
});

test("Meta+b via mouse click sends \\x1bb", async ({ page }) => {
    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => window.__wsSent.length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator("#terminal .xterm-screen").click();
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__wsSent = []; });

    var metaBtn = page.locator('[data-modifier="meta"]');
    await metaBtn.click();
    await expect(metaBtn).toHaveClass(/active/, { timeout: 2000 });

    await page.keyboard.press("b");
    await page.waitForTimeout(500);

    var messages = await page.evaluate(() => window.__wsSent);
    var inputs = getInputs(messages);
    console.log("Meta+b inputs:", JSON.stringify(inputs));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[inputs.length - 1].data).toBe("\x1bb");

    await expect(metaBtn).not.toHaveClass(/active/, { timeout: 2000 });
});

test("Touch tap on Ctrl toggles active and Ctrl+C works", async ({ browser }) => {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();

    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => window.__wsSent.length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__wsSent = []; });

    var ctrlBtn = page.locator('[data-modifier="ctrl"]');
    await ctrlBtn.tap();
    await page.waitForTimeout(200);

    var hasActive = await ctrlBtn.evaluate((el) => el.classList.contains("active"));
    console.log("Touch: Ctrl active after tap:", hasActive);
    expect(hasActive).toBe(true);

    await page.keyboard.press("c");
    await page.waitForTimeout(500);

    var messages = await page.evaluate(() => window.__wsSent);
    var inputs = getInputs(messages);
    console.log("Touch Ctrl+C inputs:", JSON.stringify(inputs));
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[inputs.length - 1].data).toBe("\x03");

    hasActive = await ctrlBtn.evaluate((el) => el.classList.contains("active"));
    expect(hasActive).toBe(false);

    await context.close();
});

test("Ctrl+C produces ^C in terminal output (end-to-end)", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(2000);

    await page.locator("#terminal .xterm-screen").click();
    await page.waitForTimeout(200);

    var ctrlBtn = page.locator('[data-modifier="ctrl"]');
    await ctrlBtn.click();
    await page.keyboard.press("c");
    await page.waitForTimeout(1000);

    var text = await page.locator("#terminal .xterm-screen").textContent();
    console.log("Terminal text contains ^C:", text.includes("^C"));
    expect(text).toContain("^C");
});
