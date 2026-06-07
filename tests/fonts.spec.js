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

// Elements that previously fell back to the browser's serif default
// (Times New Roman) because no font-family was set on them or their ancestors.
const SELECTORS = [
    "#toast",
    "#select-label",
    "#select-copy-btn",
    "#select-done-btn",
    "#paste-label",
    "#paste-area",
    "#paste-send-btn",
    "#paste-cancel-btn",
    "#settings-close-btn",
    "#system-keyboard-toggle",
];

test("UI chrome uses the app font, never the serif default", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });

    var fonts = await page.evaluate((selectors) => {
        var out = {};
        selectors.forEach(function (sel) {
            var el = document.querySelector(sel);
            out[sel] = el ? getComputedStyle(el).fontFamily : "MISSING";
        });
        return out;
    }, SELECTORS);

    for (var sel in fonts) {
        expect(fonts[sel], sel + " should exist").not.toBe("MISSING");
        expect(fonts[sel].toLowerCase(), sel + " should not be serif/Times").not.toMatch(/serif|times/);
        expect(fonts[sel].toLowerCase(), sel + " should use the app monospace stack").toContain("monospace");
    }
});
