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

async function waitForTerminalReady(page) {
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(1000);
}

async function newTouchPage(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    return { context: context, page: page };
}

test("Esc button sits immediately to the right of Ctrl in the button bar", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);

    // Both buttons exist in the bar.
    var ctrl = page.locator('#button-scroll [data-modifier="ctrl"]');
    var esc = page.locator('#button-scroll [data-key="escape"]');
    await expect(ctrl).toHaveCount(1);
    await expect(esc).toHaveCount(1);

    // DOM order: Esc is the very next .bar-btn after Ctrl.
    var order = await page.locator("#button-scroll .bar-btn").evaluateAll((btns) => {
        return btns.map(function (b) {
            return b.getAttribute("data-modifier") || b.getAttribute("data-key") || b.getAttribute("data-action");
        });
    });
    var ctrlIdx = order.indexOf("ctrl");
    var escIdx = order.indexOf("escape");
    expect(ctrlIdx).toBeGreaterThanOrEqual(0);
    expect(escIdx).toBe(ctrlIdx + 1);

    // Esc is positioned to the right of Ctrl on screen.
    var ctrlBox = await ctrl.boundingBox();
    var escBox = await esc.boundingBox();
    expect(escBox.x).toBeGreaterThan(ctrlBox.x);

    await context.close();
});

test("Tapping Esc in the button bar sends \\x1b", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.goto("/");
    await waitForTerminalReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__wsSent = []; });

    await page.locator('#button-scroll [data-key="escape"]').tap();
    await page.waitForTimeout(300);

    var messages = await page.evaluate(() => window.__wsSent);
    var inputs = getInputs(messages);
    expect(inputs.length).toBeGreaterThan(0);
    expect(inputs[inputs.length - 1].data).toBe("\x1b");

    await context.close();
});

test("On-screen keyboard has no Esc key in letters mode", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 2000 });

    // Letters mode is the default; no Esc key in the keyboard.
    await expect(page.locator('#touch-keyboard [data-touch-key="escape"]')).toHaveCount(0);

    await context.close();
});

test("Disabling a button in settings removes it from the bar and persists", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);

    // Tab button present initially.
    await expect(page.locator('#button-scroll [data-key="tab"]')).toHaveCount(1);

    // Open settings and uncheck Tab.
    await page.locator("#settings-btn").tap();
    await expect(page.locator("#settings-panel")).not.toHaveClass(/hidden/, { timeout: 2000 });

    var tabToggle = page.locator('[data-bar-toggle="tab"]');
    await expect(tabToggle).toHaveCount(1);
    await expect(tabToggle).toBeChecked();
    await tabToggle.uncheck();

    // Live removal from the bar.
    await expect(page.locator('#button-scroll [data-key="tab"]')).toHaveCount(0);

    await page.locator("#settings-close-btn").tap();
    await expect(page.locator("#settings-panel")).toHaveClass(/hidden/, { timeout: 2000 });

    // Persists across reload.
    await page.reload();
    await waitForTerminalReady(page);
    await expect(page.locator('#button-scroll [data-key="tab"]')).toHaveCount(0);

    // Re-enable restores it.
    await page.locator("#settings-btn").tap();
    await expect(page.locator("#settings-panel")).not.toHaveClass(/hidden/, { timeout: 2000 });
    var tabToggle2 = page.locator('[data-bar-toggle="tab"]');
    await expect(tabToggle2).not.toBeChecked();
    await tabToggle2.check();
    await expect(page.locator('#button-scroll [data-key="tab"]')).toHaveCount(1);

    await context.close();
});
