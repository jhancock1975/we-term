const { test, expect } = require("@playwright/test");
const { TEST_BASE_URL, startServer, waitForServer, stopServer } = require("./helpers");

let serverProcess;

test.beforeAll(async () => {
    serverProcess = startServer();
    await waitForServer(serverProcess);
});

test.afterAll(async () => {
    await stopServer(serverProcess);
});

async function waitForTerminalReady(page) {
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(1500);
}

async function newTouchPage(browser, permissions) {
    var context = await browser.newContext({ hasTouch: true });
    if (permissions && permissions.length > 0) {
        // WebKit rejects unknown permission names (e.g. clipboard-write), so
        // grant best-effort and don't fail setup if unsupported.
        try {
            await context.grantPermissions(permissions, { origin: TEST_BASE_URL });
        } catch (err) {
            // ignore - clipboard-dependent assertions are skipped on WebKit
        }
    }
    var page = await context.newPage();
    return { context: context, page: page };
}

// The on-screen keyboard long-press (>600ms) enters select mode. Use 750ms.
async function longPressTerminal(page, offsetX, offsetY, delayMs) {
    var screen = page.locator("#terminal .xterm-screen");
    var box = await screen.boundingBox();
    var clientX = box.x + offsetX;
    var clientY = box.y + offsetY;

    await page.evaluate(({ clientX, clientY, delayMs }) => {
        function buildTouchEvent(type, touchListName) {
            var event = new Event(type, { bubbles: true, cancelable: true });
            var touches = [{ clientX: clientX, clientY: clientY }];
            Object.defineProperty(event, "touches", { value: touchListName === "touches" ? touches : [] });
            Object.defineProperty(event, "changedTouches", { value: touches });
            return event;
        }

        return new Promise(function (resolve) {
            var target = document.querySelector("#terminal .xterm-screen");
            target.dispatchEvent(buildTouchEvent("touchstart", "touches"));
            setTimeout(function () {
                target.dispatchEvent(buildTouchEvent("touchend", "changedTouches"));
                resolve();
            }, delayMs);
        });
    }, { clientX: clientX, clientY: clientY, delayMs: delayMs || 750 });
}

async function ensureTouchTerminalOutput(page) {
    var hasRows = await page.evaluate(() => {
        var rows = document.querySelector("#terminal .xterm-rows");
        return !!rows && rows.textContent.trim().length > 0;
    });
    if (hasRows) {
        return;
    }
    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);
    await page.locator('[data-touch-key="enter"]').tap();
    await page.waitForFunction(() => {
        var rows = document.querySelector("#terminal .xterm-rows");
        return !!rows && rows.textContent.trim().length > 0;
    }, {}, { timeout: 10000 });
}

async function ensureKeyboardVisible(page) {
    var hidden = await page.locator("#touch-keyboard").evaluate((el) => el.classList.contains("hidden"));
    if (hidden) {
        await page.locator("#terminal .xterm-screen").tap();
        await page.waitForTimeout(200);
    }
}

async function typeViaKeys(page, str) {
    for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        if (ch === "\n") {
            await page.locator('[data-touch-key="enter"]').tap();
        } else if (ch === " ") {
            await page.locator('[data-touch-key="space"]').tap();
        } else if (ch >= "A" && ch <= "Z") {
            await page.locator('[data-touch-key="shift"]').tap();
            await page.locator('[data-touch-key="' + ch.toLowerCase() + '"]').tap();
        } else if (ch === "_") {
            await page.locator('[data-touch-key="shift"]').tap();
            await page.locator('[data-touch-key="-"]').tap();
        } else {
            await page.locator('[data-touch-key="' + ch + '"]').tap();
        }
        await page.waitForTimeout(40);
    }
}

async function typeInTerminal(page, text) {
    await ensureKeyboardVisible(page);
    await typeViaKeys(page, text);
    await page.locator('[data-touch-key="enter"]').tap();
    await page.waitForTimeout(500);
}

async function waitForTerminalText(page, text, timeout) {
    await expect.poll(async () => {
        return await page.evaluate(() => {
            var rows = document.querySelector("#terminal .xterm-rows");
            return rows ? rows.textContent : "";
        });
    }, { timeout: timeout || 5000 }).toContain(text);
}

// Select a marker substring (or the first word) inside the in-place overlay,
// mimicking the user's native long-press selection. Returns the selected text.
async function selectInOverlay(page, marker) {
    return await page.evaluate((marker) => {
        var node = document.getElementById("select-content").firstChild;
        if (!node) return "";
        var text = node.textContent || "";
        var start = marker ? text.indexOf(marker) : text.search(/\S/);
        if (start < 0) return "";
        var end;
        if (marker) {
            end = start + marker.length;
        } else {
            end = start;
            while (end < text.length && /\S/.test(text[end])) end++;
        }
        var range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, end);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        return sel.toString();
    }, marker);
}

// Trigger the browser's native copy of the current selection - the desktop
// equivalent of tapping iOS's "Copy" callout.
async function nativeCopy(page) {
    return await page.evaluate(() => document.execCommand("copy"));
}

async function dismissOverlay(page) {
    // Past the open-suppression window, a tap with no selection dismisses.
    await page.waitForTimeout(500);
    await page.evaluate(() => { var s = window.getSelection(); if (s) s.removeAllRanges(); });
    await page.locator("#select-overlay").tap();
}

test("Long press opens an in-place select overlay (no full-screen sheet, no toolbar)", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await longPressTerminal(page, 72, 24, 750);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });

    // No Copy/Done toolbar - selection is native iOS, dismissed by tapping away.
    expect(await page.locator("#select-copy-btn").count()).toBe(0);
    expect(await page.locator("#select-done-btn").count()).toBe(0);

    // Shows the terminal's text, positioned in place over the terminal area.
    var overlayText = await page.evaluate(() => document.getElementById("select-content").textContent);
    expect(overlayText.trim().length).toBeGreaterThan(0);
    var ov = await page.locator("#select-overlay").boundingBox();
    var scr = await page.locator("#terminal .xterm-screen").boundingBox();
    expect(Math.abs(ov.x - scr.x)).toBeLessThan(4);
    expect(Math.abs(ov.y - scr.y)).toBeLessThan(4);

    await result.context.close();
});

test("Selecting text then copying puts it on the clipboard and dismisses", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "clipboard read/write not available in Playwright WebKit");
    var result = await newTouchPage(browser, ["clipboard-read", "clipboard-write"]);
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await typeInTerminal(page, "echo COPY_TEST_MARKER_12345");
    await waitForTerminalText(page, "COPY_TEST_MARKER_12345");

    await longPressTerminal(page, 72, 24, 750);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });

    var overlayText = await page.evaluate(() => document.getElementById("select-content").textContent);
    expect(overlayText).toContain("COPY_TEST_MARKER_12345");

    var selected = await selectInOverlay(page, "COPY_TEST_MARKER_12345");
    expect(selected).toBe("COPY_TEST_MARKER_12345");

    await nativeCopy(page);

    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });
    await expect(page.locator("#toast")).toHaveClass(/show/, { timeout: 2000 });

    var clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe("COPY_TEST_MARKER_12345");

    await result.context.close();
});

test("Tapping the overlay with no selection dismisses without copying", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "clipboard read/write not available in Playwright WebKit");
    var result = await newTouchPage(browser, ["clipboard-read", "clipboard-write"]);
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);
    await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));

    await longPressTerminal(page, 72, 24, 750);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });

    await dismissOverlay(page);

    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });
    var clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe("SENTINEL");

    await result.context.close();
});

test("Copy specific text from a screen session", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "clipboard read/write not available in Playwright WebKit");
    var result = await newTouchPage(browser, ["clipboard-read", "clipboard-write"]);
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);

    try {
        await typeInTerminal(page, "screen -dmS test_session");
        await page.waitForTimeout(500);
        await typeInTerminal(page, "screen -r test_session");
        await page.waitForTimeout(1000);
        await typeInTerminal(page, "echo SCREEN_COPY_TEST_67890");
        await waitForTerminalText(page, "SCREEN_COPY_TEST_67890");

        await longPressTerminal(page, 72, 24, 750);
        await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });

        var selected = await selectInOverlay(page, "SCREEN_COPY_TEST_67890");
        expect(selected).toBe("SCREEN_COPY_TEST_67890");

        await nativeCopy(page);
        await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

        var clipboardText = await page.evaluate(() => navigator.clipboard.readText());
        expect(clipboardText).toBe("SCREEN_COPY_TEST_67890");

        await typeInTerminal(page, "exit");
        await page.waitForTimeout(500);
    } finally {
        // Always reap the session so a failed run doesn't orphan a screen.
        await typeInTerminal(page, "screen -X -S test_session quit").catch(() => {});
        await page.waitForTimeout(200);
    }

    await result.context.close();
});

test("Sel button opens in-place select mode; tapping away dismisses", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);

    await page.locator("#select-btn").tap();
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });
    expect(await page.locator("#select-copy-btn").count()).toBe(0);

    await dismissOverlay(page);
    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    await result.context.close();
});
