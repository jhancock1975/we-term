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

async function newTouchPage(browser, systemKeyboard) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    if (systemKeyboard) {
        await page.addInitScript(() => {
            localStorage.setItem("we-term-settings", JSON.stringify({
                cursorBlink: true, hapticFeedback: true, systemKeyboard: true,
            }));
        });
    }
    return { context: context, page: page };
}

// Bring a fresh touch page to a ready terminal (rendered prompt) without
// tapping it yet, so each test controls when the keyboard/gear appears.
async function gotoReady(page) {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(800);
}

// Type a string by tapping the on-screen JS keyboard keys (the realistic path,
// since the xterm textarea is intentionally un-focusable on touch).
async function typeViaKeys(page, str) {
    for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        if (ch === "\n" || ch === "\r") {
            await page.locator('[data-touch-key="enter"]').tap();
        } else if (ch === " ") {
            await page.locator('[data-touch-key="space"]').tap();
        } else if (ch >= "A" && ch <= "Z") {
            await page.locator('[data-touch-key="shift"]').tap();
            await page.locator('[data-touch-key="' + ch.toLowerCase() + '"]').tap();
        } else {
            await page.locator('[data-touch-key="' + ch + '"]').tap();
        }
        await page.waitForTimeout(60);
    }
}

// Rendered terminal text only (excludes xterm's injected <style> element).
async function screenText(page) {
    return await page.evaluate(() => {
        var rows = document.querySelector("#terminal .xterm-rows");
        if (!rows) return "";
        return Array.from(rows.children).map(function (r) { return r.textContent; }).join("\n");
    });
}

test("Gear stays hidden in default JS-keyboard mode", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    await page.locator("#terminal .xterm-screen").tap();

    // Default (JS-keyboard) mode: tapping shows the on-screen keyboard...
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 2000 });
    // ...and the system-keyboard gear must stay hidden.
    await expect(page.locator("#keyboard-gear")).toHaveClass(/hidden/);

    await result.context.close();
});

test("Cursor overlay hides when scrolled into scrollback", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    // Show the JS keyboard so we can type the command.
    await page.locator("#terminal .xterm-screen").tap();
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 2000 });

    // Cursor overlay should be visible at the live prompt before scrolling.
    await expect(page.locator("#touch-cursor")).not.toHaveClass(/hidden/, { timeout: 5000 });

    // Produce plenty of scrollback so scrolling up leaves the live viewport.
    await typeViaKeys(page, "seq 200\n");
    await expect.poll(async () => {
        return await screenText(page);
    }, { timeout: 10000 }).toContain("200");
    await page.waitForTimeout(500);

    // Scroll up into the scrollback. The cursor overlay hides because the
    // viewport is no longer pinned to the live cursor row.
    await page.evaluate(() => {
        var vp = document.querySelector("#terminal .xterm-viewport");
        vp.scrollTop = 0;
        vp.dispatchEvent(new WheelEvent("wheel", { deltaY: -1000, bubbles: true }));
    });
    await expect(page.locator("#touch-cursor")).toHaveClass(/hidden/, { timeout: 8000 });

    // Scroll back to the bottom; the cursor overlay returns.
    await page.evaluate(() => {
        var vp = document.querySelector("#terminal .xterm-viewport");
        vp.scrollTop = vp.scrollHeight;
        vp.dispatchEvent(new WheelEvent("wheel", { deltaY: 1000, bubbles: true }));
    });
    await expect(page.locator("#touch-cursor")).not.toHaveClass(/hidden/, { timeout: 8000 });

    await result.context.close();
});

test("Help is reachable and closable in system-keyboard mode via the gear", async ({ browser }) => {
    var result = await newTouchPage(browser, true);
    var page = result.page;
    await gotoReady(page);

    // Tap the terminal to surface the floating gear.
    await page.locator("#terminal .xterm-screen").tap();
    await expect(page.locator("#keyboard-gear")).not.toHaveClass(/hidden/, { timeout: 2000 });

    // Gear opens Settings.
    await page.locator("#keyboard-gear").tap();
    await expect(page.locator("#settings-panel")).not.toHaveClass(/hidden/, { timeout: 2000 });

    // Settings -> Help opens the full-screen help overlay.
    await page.locator("#help-btn").tap();
    await expect(page.locator("#help-overlay")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await expect(page.locator("#help-close-btn")).toBeVisible();

    // Closing Help dismisses the overlay.
    await page.locator("#help-close-btn").tap();
    await expect(page.locator("#help-overlay")).toHaveClass(/hidden/, { timeout: 2000 });

    await result.context.close();
});
