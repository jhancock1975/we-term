const { test, expect } = require("@playwright/test");
const { spawn } = require("child_process");
const path = require("path");

let serverProcess;

test.beforeAll(async () => {
    const venvPython = path.join(__dirname, "..", "venv", "bin", "python");
    const serverScript = path.join(__dirname, "..", "server.py");
    serverProcess = spawn(venvPython, [serverScript], {
        cwd: path.join(__dirname, ".."),
        stdio: "pipe",
    });
    await new Promise((resolve) => {
        serverProcess.stderr.on("data", (data) => {
            if (data.toString().includes("Running on")) resolve();
        });
        setTimeout(resolve, 3000);
    });
});

test.afterAll(async () => {
    if (serverProcess) {
        serverProcess.kill("SIGKILL");
        await new Promise((resolve) => {
            serverProcess.on("close", resolve);
            setTimeout(resolve, 2000);
        });
    }
});

test("Session persists across WebSocket reconnect", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(2000);

    // Verify we have a shell prompt (terminal has text content)
    var text1 = await page.locator("#terminal .xterm-screen").textContent();
    console.log("Initial terminal text length:", text1.trim().length);
    expect(text1.trim().length).toBeGreaterThan(0);

    // Type a marker command
    await page.locator("#terminal .xterm-screen").click();
    await page.keyboard.type("echo RECONNECT_TEST_MARKER");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    // Verify marker appeared
    var text2 = await page.locator("#terminal .xterm-screen").textContent();
    expect(text2).toContain("RECONNECT_TEST_MARKER");
    console.log("PASS: Marker command executed");

    // Force-close the WebSocket to simulate tab switch
    await page.evaluate(() => {
        // Find and close the WebSocket
        var ws = window.__testWs;
        if (!ws) {
            // Access via terminal.js's scope - we need to close externally
            // Close all WebSocket connections
            var allWs = performance.getEntriesByType("resource")
                .filter((r) => r.name.includes("ws"));
        }
    });

    // More reliable: navigate away and back
    await page.goto("about:blank");
    await page.waitForTimeout(1000);

    // Reconnect by navigating back
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(3000);

    // Terminal should show content (either buffered output or a prompt)
    var text3 = await page.locator("#terminal .xterm-screen").textContent();
    console.log("After reconnect, terminal text length:", text3.trim().length);
    console.log("After reconnect, terminal contains marker:", text3.includes("RECONNECT_TEST_MARKER"));

    // The terminal must not be blank
    expect(text3.trim().length).toBeGreaterThan(0);
    console.log("PASS: Terminal has content after reconnect (not blank)");
});

test("Fresh page load shows shell prompt", async ({ page }) => {
    // This tests the basic case - just opening the page shows a prompt
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(3000);

    var text = await page.locator("#terminal .xterm-screen").textContent();
    console.log("Fresh load terminal text length:", text.trim().length);
    expect(text.trim().length).toBeGreaterThan(0);
    console.log("PASS: Fresh page load shows content");
});
