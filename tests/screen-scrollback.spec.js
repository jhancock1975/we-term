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

function inputs(messages) {
    return messages
        .map((m) => { try { return JSON.parse(m); } catch (e) { return null; } })
        .filter((m) => m && m.type === "input")
        .map((m) => m.data);
}

test("The Scrl button sends Ctrl-A [ to enter screen copy mode", async ({ browser }) => {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(500);

    var scrl = page.locator('#button-scroll [data-key="screencopy"]');
    await expect(scrl).toHaveCount(1);

    await page.evaluate(() => { window.__wsSent = []; });
    await scrl.tap();
    await page.waitForTimeout(200);

    var sent = inputs(await page.evaluate(() => window.__wsSent));
    expect(sent.join("")).toContain("\x01[");

    await context.close();
});
