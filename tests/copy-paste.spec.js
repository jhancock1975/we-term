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
        await context.grantPermissions(permissions, { origin: TEST_BASE_URL });
    }
    var page = await context.newPage();
    return { context: context, page: page };
}

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
    }, { clientX: clientX, clientY: clientY, delayMs: delayMs || 600 });
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

async function typeInTerminal(page, text) {
    await page.locator("#terminal .xterm-screen").click();
    await page.waitForTimeout(200);
    await page.keyboard.type(text);
    await page.keyboard.press("Enter");
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

test("Long press opens select overlay with toolbar", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await longPressTerminal(page, 72, 24, 650);

    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });
    await expect(page.locator("#select-toolbar")).toBeVisible();
    await expect(page.locator("#select-copy-btn")).toBeVisible();
    await expect(page.locator("#select-done-btn")).toBeVisible();
    await expect(page.locator("#select-label")).toHaveText("Select text, then tap Copy");

    await context.close();
});

test("Copy button copies selected text to clipboard", async ({ browser }) => {
    var result = await newTouchPage(browser, ["clipboard-read", "clipboard-write"]);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await longPressTerminal(page, 72, 24, 650);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 5000 });

    await page.waitForFunction(() => {
        return document.getElementById("select-overlay").dataset.selectedText.trim().length > 0;
    }, {}, { timeout: 5000 });

    var selectedText = await page.evaluate(() => {
        return document.getElementById("select-overlay").dataset.selectedText;
    });
    expect(selectedText.trim().length).toBeGreaterThan(0);

    await page.locator("#select-copy-btn").click();

    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });
    await expect(page.locator("#toast")).toHaveClass(/show/, { timeout: 2000 });

    var clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(selectedText);

    await context.close();
});

test("Copy button works via touch tap", async ({ browser }) => {
    var result = await newTouchPage(browser, ["clipboard-read", "clipboard-write"]);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await longPressTerminal(page, 72, 24, 650);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });
    await page.waitForFunction(() => {
        return document.getElementById("select-overlay").dataset.selectedText.trim().length > 0;
    }, {}, { timeout: 3000 });

    var selectedText = await page.evaluate(() => {
        return document.getElementById("select-overlay").dataset.selectedText;
    });

    await page.locator("#select-copy-btn").tap();

    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    var clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(selectedText);

    await context.close();
});

test("Done button closes select overlay without copying", async ({ browser }) => {
    var result = await newTouchPage(browser, ["clipboard-read", "clipboard-write"]);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));

    await longPressTerminal(page, 72, 24, 650);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });
    await page.waitForFunction(() => {
        return document.getElementById("select-overlay").dataset.selectedText.trim().length > 0;
    }, {}, { timeout: 3000 });

    await page.locator("#select-done-btn").tap();

    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    var clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe("SENTINEL");

    await context.close();
});

test("Copy works with fallback when clipboard API is unavailable", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.addInitScript(() => {
        window.__fallbackCopyText = "";
        Object.defineProperty(window, "isSecureContext", {
            configurable: true,
            get: function () { return false; },
        });
        document.execCommand = function (command) {
            if (command !== "copy") return false;
            var active = document.activeElement;
            window.__fallbackCopyText = active && "value" in active ? active.value : "";
            return true;
        };
    });

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await longPressTerminal(page, 72, 24, 650);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 5000 });
    await page.waitForFunction(() => {
        return document.getElementById("select-overlay").dataset.selectedText.trim().length > 0;
    }, {}, { timeout: 5000 });

    var selectedText = await page.evaluate(() => {
        return document.getElementById("select-overlay").dataset.selectedText;
    });

    await page.locator("#select-copy-btn").tap();
    await expect(page.locator("#toast")).toHaveClass(/show/, { timeout: 2000 });

    var copiedText = await page.evaluate(() => window.__fallbackCopyText);
    expect(copiedText).toBe(selectedText);

    await context.close();
});

test("Copy specific text from bash echo output", async ({ browser }) => {
    var result = await newTouchPage(browser, ["clipboard-read", "clipboard-write"]);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);

    await typeInTerminal(page, "echo COPY_TEST_MARKER_12345");
    await waitForTerminalText(page, "COPY_TEST_MARKER_12345");

    await longPressTerminal(page, 72, 24, 650);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });

    var overlayText = await page.evaluate(() => {
        return document.getElementById("select-content").textContent;
    });
    expect(overlayText).toContain("COPY_TEST_MARKER_12345");

    await page.evaluate(() => {
        var textNode = document.getElementById("select-content").firstChild;
        if (!textNode) return;
        var text = textNode.textContent;
        var start = text.indexOf("COPY_TEST_MARKER_12345");
        if (start < 0) return;
        var end = start + "COPY_TEST_MARKER_12345".length;
        var range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });

    await page.waitForTimeout(200);

    await page.locator("#select-copy-btn").tap();
    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    var clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe("COPY_TEST_MARKER_12345");

    await context.close();
});

test("Copy text from screen session", async ({ browser }) => {
    var result = await newTouchPage(browser, ["clipboard-read", "clipboard-write"]);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);

    await typeInTerminal(page, "screen -dmS test_session");
    await page.waitForTimeout(500);
    await typeInTerminal(page, "screen -r test_session");
    await page.waitForTimeout(1000);

    await page.locator("#terminal .xterm-screen").click();
    await page.waitForTimeout(200);
    await page.keyboard.type("echo SCREEN_COPY_TEST_67890");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1000);

    await waitForTerminalText(page, "SCREEN_COPY_TEST_67890");

    await longPressTerminal(page, 72, 24, 650);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });

    var overlayText = await page.evaluate(() => {
        return document.getElementById("select-content").textContent;
    });
    expect(overlayText).toContain("SCREEN_COPY_TEST_67890");

    await page.evaluate(() => {
        var textNode = document.getElementById("select-content").firstChild;
        if (!textNode) return;
        var text = textNode.textContent;
        var start = text.indexOf("SCREEN_COPY_TEST_67890");
        if (start < 0) return;
        var end = start + "SCREEN_COPY_TEST_67890".length;
        var range = document.createRange();
        range.setStart(textNode, start);
        range.setEnd(textNode, end);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
    });

    await page.waitForTimeout(200);

    await page.locator("#select-copy-btn").tap();
    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    var clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe("SCREEN_COPY_TEST_67890");

    await page.locator("#terminal .xterm-screen").click();
    await page.waitForTimeout(200);
    await page.keyboard.type("exit");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    await context.close();
});

test("Sel button in bar opens select mode", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);

    await page.locator("#select-btn").tap();
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });
    await expect(page.locator("#select-toolbar")).toBeVisible();

    await page.locator("#select-done-btn").tap();
    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    await context.close();
});
