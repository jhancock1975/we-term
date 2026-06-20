const { test, expect } = require("@playwright/test");
const { startServer, waitForServer, stopServer, TEST_BASE_URL } = require("./helpers");

let serverProcess;

test.beforeAll(async () => {
    serverProcess = startServer();
    await waitForServer(serverProcess);
});

test.afterAll(async () => {
    await stopServer(serverProcess);
});

test("/screen-config reports and toggles the managed screenrc altscreen state", async ({ request }) => {
    // GET returns the current state (default: full-screen scrollback ON => altscreenOff true).
    var res = await request.get(TEST_BASE_URL + "/screen-config");
    expect(res.ok()).toBeTruthy();
    var body = await res.json();
    expect(typeof body.altscreenOff).toBe("boolean");

    // POST off, then on, and verify the reported state follows.
    var off = await request.post(TEST_BASE_URL + "/screen-config", { data: { altscreenOff: false } });
    expect((await off.json()).altscreenOff).toBe(false);

    var on = await request.post(TEST_BASE_URL + "/screen-config", { data: { altscreenOff: true } });
    expect((await on.json()).altscreenOff).toBe(true);
});

test("the settings panel has a Full-screen app scrollback toggle reflecting server state", async ({ browser }) => {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(400);

    await page.locator("#settings-btn").tap();
    await page.waitForTimeout(200);
    var toggle = page.locator("#screen-scrollback-toggle");
    await expect(toggle).toHaveCount(1);
    // It mirrors the server state (checked when altscreen is off).
    var serverState = await (await page.request.get("/screen-config")).json();
    await expect(toggle).toBeChecked({ checked: !!serverState.altscreenOff });

    await context.close();
});
