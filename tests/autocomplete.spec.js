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

async function newTouchPage(browser, systemKeyboard) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    if (systemKeyboard) {
        await page.addInitScript(() => {
            localStorage.setItem("we-term-settings", JSON.stringify({
                cursorBlink: true, hapticFeedback: true, systemKeyboard: true,
            }));
        });
    }
    return { context: context, page: page };
}

async function gotoReady(page) {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(600);
    await page.locator("#terminal .xterm-screen").tap(); // show keyboard
    await page.waitForTimeout(300);
}

async function typeViaKeys(page, str) {
    for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        if (ch === "\n") {
            await page.locator('[data-touch-key="enter"]').tap();
        } else if (ch === " ") {
            await page.locator('[data-touch-key="space"]').tap();
        } else {
            await page.locator('[data-touch-key="' + ch + '"]').tap();
        }
        await page.waitForTimeout(40);
    }
}

test("History suggestion appears and tapping it inserts the command + a trailing space", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    // Run a command so it lands in history.
    await typeViaKeys(page, "echo hello\n");
    await page.waitForTimeout(300);

    // Start typing its prefix -> suggestion bar should show a matching chip.
    await typeViaKeys(page, "ec");
    await expect(page.locator("#autocomplete-bar")).not.toHaveClass(/hidden/, { timeout: 2000 });
    var chip = page.locator(".ac-chip", { hasText: "echo hello" });
    await expect(chip).toBeVisible();

    // Tap the chip -> it erases the typed prefix and sends the full command + space.
    await page.evaluate(() => { window.__wsSent = []; });
    await chip.tap();
    await page.waitForTimeout(200);

    var sent = inputs(await page.evaluate(() => window.__wsSent));
    var combined = sent.join("");
    expect(combined).toContain("echo hello ");           // full command followed by a space
    expect(combined.charCodeAt(0)).toBe(0x7f);            // leading backspaces erased the typed prefix

    // The keyboard stays up (tapping a chip must not toggle the terminal).
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/);

    await result.context.close();
});

test("Built-in command completion suggests commands not yet in history", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    await typeViaKeys(page, "gi");
    await expect(page.locator("#autocomplete-bar")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await expect(page.locator(".ac-chip", { hasText: /^git$/ })).toBeVisible();

    await result.context.close();
});

test("Suggestion bar is hidden in system-keyboard mode", async ({ browser }) => {
    var result = await newTouchPage(browser, true);
    var page = result.page;
    await gotoReady(page);

    // Type via the real keyboard path (system mode focuses the xterm textarea).
    await page.keyboard.type("ec");
    await page.waitForTimeout(400);

    await expect(page.locator("#autocomplete-bar")).toHaveClass(/hidden/);

    await result.context.close();
});

test("Suggestion bar hides after submitting (Enter)", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    await typeViaKeys(page, "gi");
    await expect(page.locator("#autocomplete-bar")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await page.locator('[data-touch-key="enter"]').tap();
    await page.waitForTimeout(300);
    await expect(page.locator("#autocomplete-bar")).toHaveClass(/hidden/);

    await result.context.close();
});
