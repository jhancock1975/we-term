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
    await page.waitForTimeout(1500);
}

async function waitForRenderedRows(page) {
    await page.waitForFunction(() => {
        var rows = document.querySelector("#terminal .xterm-rows");
        return !!rows && rows.textContent.trim().length > 0;
    }, {}, { timeout: 10000 });
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
    await waitForRenderedRows(page);
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

test("Long press opens select overlay with toolbar and copy works", async ({ browser }) => {
    var result = await newTouchPage(browser, ["clipboard-read", "clipboard-write"]);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await longPressTerminal(page, 72, 24, 650);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await page.waitForFunction(() => document.getElementById("select-overlay").dataset.selectedText.trim().length > 0, {}, { timeout: 2000 });

    var selectedText = await page.locator("#select-overlay").evaluate((el) => el.dataset.selectedText);
    expect(selectedText.trim().length).toBeGreaterThan(0);

    await expect(page.locator("#select-copy-btn")).toBeVisible();
    await expect(page.locator("#select-done-btn")).toBeVisible();

    await page.locator("#select-done-btn").tap();
    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 2000 });

    await longPressTerminal(page, 72, 24, 650);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await page.waitForFunction(() => document.getElementById("select-overlay").dataset.selectedText.trim().length > 0, {}, { timeout: 2000 });

    selectedText = await page.locator("#select-overlay").evaluate((el) => el.dataset.selectedText);
    await page.locator("#select-copy-btn").tap();
    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 2000 });

    var clipboardText = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboardText).toBe(selectedText);

    await context.close();
});

test("Copy falls back when clipboard API is unavailable", async ({ browser }) => {
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
            if (command !== "copy") {
                return false;
            }
            var active = document.activeElement;
            window.__fallbackCopyText = active && "value" in active ? active.value : "";
            return true;
        };
    });

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    await longPressTerminal(page, 72, 24, 650);
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await page.waitForFunction(() => document.getElementById("select-overlay").dataset.selectedText.trim().length > 0, {}, { timeout: 2000 });
    var selectedText = await page.locator("#select-overlay").evaluate((el) => el.dataset.selectedText);

    await page.locator("#select-copy-btn").tap();
    await expect(page.locator("#toast")).toHaveClass(/show/, { timeout: 2000 });

    var copiedText = await page.evaluate(() => window.__fallbackCopyText);
    expect(copiedText).toBe(selectedText);

    await context.close();
});

test("Settings button controls touch cursor blink", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);
    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);

    var labels = await page.locator("#button-scroll .bar-btn").evaluateAll((buttons) => buttons.slice(0, 2).map((button) => button.textContent.trim()));
    expect(labels).toEqual(["⚙", "Ctrl"]);

    // Blink on by default: the cursor overlay is animated.
    await expect(page.locator("#touch-cursor")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await expect(page.locator("#touch-cursor")).not.toHaveClass(/no-blink/);

    // Disable blink via settings -> overlay becomes steady (no animation).
    await page.locator("#settings-btn").tap();
    await expect(page.locator("#settings-panel")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await expect(page.locator("#haptic-feedback-toggle")).toBeChecked();
    await page.locator("#cursor-blink-toggle").uncheck();
    await page.locator("#settings-close-btn").tap();
    await expect(page.locator("#settings-panel")).toHaveClass(/hidden/, { timeout: 2000 });
    await page.locator("#terminal .xterm-screen").tap(); // trigger a re-render of the cursor overlay
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-cursor")).toHaveClass(/no-blink/, { timeout: 2000 });

    // Persists across reload.
    await page.reload();
    await waitForTerminalReady(page);
    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-cursor")).toHaveClass(/no-blink/, { timeout: 2000 });

    await context.close();
});

test("Touch keyboard shows popout preview and honors haptic setting", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.addInitScript(() => {
        window.__vibrations = [];
        navigator.vibrate = function (pattern) {
            window.__vibrations.push(pattern);
            return true;
        };
    });

    await page.goto("/");
    await waitForTerminalReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);

    var key = page.locator('[data-touch-key="a"]');
    await key.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, button: 0, buttons: 1 });
    await expect(page.locator("#touch-key-preview")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await expect(page.locator("#touch-key-preview")).toHaveText("a");
    await key.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, button: 0, buttons: 0 });
    await expect(page.locator("#touch-key-preview")).toHaveClass(/hidden/, { timeout: 2000 });

    await page.evaluate(() => {
        window.__wsSent = [];
        window.__vibrations = [];
    });

    await key.tap();
    await page.waitForTimeout(300);

    var messages = await page.evaluate(() => window.__wsSent);
    var inputs = getInputs(messages);
    expect(inputs[inputs.length - 1].data).toBe("a");
    expect(await page.evaluate(() => window.__vibrations)).toEqual([10]);

    await page.locator("#settings-btn").tap();
    await expect(page.locator("#settings-panel")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await page.locator("#haptic-feedback-toggle").uncheck();
    await page.locator("#settings-close-btn").tap();
    await expect(page.locator("#settings-panel")).toHaveClass(/hidden/, { timeout: 2000 });
    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);

    await page.evaluate(() => {
        window.__wsSent = [];
        window.__vibrations = [];
    });

    var keyB = page.locator('[data-touch-key="b"]');
    await keyB.tap();
    await page.waitForTimeout(300);

    messages = await page.evaluate(() => window.__wsSent);
    inputs = getInputs(messages);
    expect(inputs[inputs.length - 1].data).toBe("b");
    expect(await page.evaluate(() => window.__vibrations)).toEqual([]);

    await context.close();
});

test("Ctrl+C via mouse click sends \\x03", async ({ page }) => {
    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.goto("/");
    await waitForTerminalReady(page);

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
    await waitForTerminalReady(page);

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

test("Touch tap on terminal opens JS keyboard and sends typed input", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.goto("/");
    await waitForTerminalReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 2000 });

    var helperState = await page.locator("#terminal .xterm-helper-textarea").evaluate((el) => ({
        readOnly: el.readOnly,
        inputMode: el.getAttribute("inputmode"),
    }));
    expect(helperState.readOnly).toBe(true);
    expect(helperState.inputMode).toBe("none");

    await page.evaluate(() => { window.__wsSent = []; });

    await page.locator('[data-touch-key="a"]').tap();
    await page.locator('[data-touch-key="b"]').tap();
    await page.locator('[data-touch-key="enter"]').tap();
    await page.waitForTimeout(500);

    var messages = await page.evaluate(() => window.__wsSent);
    var inputs = getInputs(messages);
    console.log("Touch keyboard inputs:", JSON.stringify(inputs));
    expect(inputs.slice(-3).map((input) => input.data)).toEqual(["a", "b", "\r"]);

    // Single tap on the terminal toggles the keyboard closed (no Hide key).
    await page.locator("#terminal .xterm-screen").tap();
    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/, { timeout: 2000 });

    await context.close();
});

test("Touch tap on Ctrl toggles active and Ctrl+C works through JS keyboard", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.goto("/");
    await waitForTerminalReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);
    await page.evaluate(() => { window.__wsSent = []; });

    var ctrlBtn = page.locator('[data-modifier="ctrl"]');
    await ctrlBtn.tap();
    await page.waitForTimeout(200);

    var hasActive = await ctrlBtn.evaluate((el) => el.classList.contains("active"));
    console.log("Touch: Ctrl active after tap:", hasActive);
    expect(hasActive).toBe(true);

    await page.locator('[data-touch-key="c"]').tap();
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

test("Ctrl+C interrupts a running command (end-to-end)", async ({ page }) => {
    await page.goto("/");
    await waitForTerminalReady(page);

    await page.locator("#terminal .xterm-screen").click();
    await page.waitForTimeout(200);
    await page.keyboard.type("sleep 10");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(500);

    var ctrlBtn = page.locator('[data-modifier="ctrl"]');
    await ctrlBtn.click();
    await page.keyboard.press("c");
    await page.waitForTimeout(500);

    await page.keyboard.type("echo INTERRUPT_OK");
    await page.keyboard.press("Enter");

    await expect.poll(async () => {
        var text = await page.locator("#terminal .xterm-screen").textContent();
        return text.includes("INTERRUPT_OK");
    }, { timeout: 5000 }).toBe(true);
});
