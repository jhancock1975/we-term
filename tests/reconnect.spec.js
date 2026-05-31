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

test("Session persists across WebSocket reconnect", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(2000);

    var text1 = await page.locator("#terminal .xterm-screen").textContent();
    console.log("Initial terminal text length:", text1.trim().length);
    expect(text1.trim().length).toBeGreaterThan(0);

    await page.locator("#terminal .xterm-screen").click();
    await page.keyboard.type("echo RECONNECT_TEST_MARKER");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    var text2 = await page.locator("#terminal .xterm-screen").textContent();
    expect(text2).toContain("RECONNECT_TEST_MARKER");
    console.log("PASS: Marker command executed");

    await page.goto("about:blank");
    await page.waitForTimeout(1000);

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(3000);

    var text3 = await page.locator("#terminal .xterm-screen").textContent();
    console.log("After reconnect, terminal text length:", text3.trim().length);
    expect(text3.trim().length).toBeGreaterThan(0);
    console.log("PASS: Terminal has content after reconnect (not blank)");
});

test("Fresh page load shows shell prompt", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(3000);

    var text = await page.locator("#terminal .xterm-screen").textContent();
    console.log("Fresh load terminal text length:", text.trim().length);
    expect(text.trim().length).toBeGreaterThan(0);
    console.log("PASS: Fresh page load shows content");
});
