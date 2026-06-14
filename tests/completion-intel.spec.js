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

async function newTouchPage(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    await page.addInitScript(WS_INTERCEPT_SCRIPT);
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

test("Porter stemmer reduces words to expected stems", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    var stems = await page.evaluate(() => {
        return {
            running: window.stemWord("running"),
            happiness: window.stemWord("happiness"),
            cats: window.stemWord("cats"),
            learning: window.stemWord("learning"),
            relational: window.stemWord("relational"),
            agreed: window.stemWord("agreed"),
        };
    });

    expect(stems.running).toBe("run");
    expect(stems.happiness).toBe("happi");
    expect(stems.cats).toBe("cat");
    expect(stems.learning).toBe("learn");
    expect(stems.relational).toBe("relat");
    expect(stems.agreed).toBe("agre");

    await result.context.close();
});

test("Word candidates surface first for a close dictionary match", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    // "lear" is a prefix of "learn" (which is in GLIDE_WORDS) and not a
    // command, so a word chip completing to "learn" should appear, ahead of
    // any command-y suggestions.
    await typeViaKeys(page, "lear");
    await expect(page.locator("#autocomplete-bar")).not.toHaveClass(/hidden/, { timeout: 2000 });

    var learnChip = page.locator(".ac-chip", { hasText: /^learn$/ });
    await expect(learnChip).toBeVisible({ timeout: 2000 });

    // It is the first chip (words rank first when the token matches).
    var firstText = await page.locator(".ac-chip").first().textContent();
    expect(firstText.trim()).toBe("learn");

    // Tapping completes the line to "learn ".
    await page.evaluate(() => { window.__wsSent = []; });
    await learnChip.tap();
    await page.waitForTimeout(200);
    var sent = (await page.evaluate(() => window.__wsSent))
        .map((m) => { try { return JSON.parse(m); } catch (e) { return null; } })
        .filter((m) => m && m.type === "input")
        .map((m) => m.data).join("");
    expect(sent).toContain("learn ");

    await result.context.close();
});

test("Word candidate replaces only the last token", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    // After a command + space, the last token "worl" should surface the word
    // "world" with the command head preserved.
    await typeViaKeys(page, "echo worl");
    await expect(page.locator("#autocomplete-bar")).not.toHaveClass(/hidden/, { timeout: 2000 });
    var worldChip = page.locator(".ac-chip", { hasText: /^world$/ });
    await expect(worldChip).toBeVisible({ timeout: 2000 });

    await page.evaluate(() => { window.__wsSent = []; });
    await worldChip.tap();
    await page.waitForTimeout(200);
    var sent = (await page.evaluate(() => window.__wsSent))
        .map((m) => { try { return JSON.parse(m); } catch (e) { return null; } })
        .filter((m) => m && m.type === "input")
        .map((m) => m.data).join("");
    expect(sent).toContain("echo world ");

    await result.context.close();
});

test("Non-word command token falls back to command sources without spurious word chips", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    // Seed a non-dictionary command into history.
    await typeViaKeys(page, "systemctl\n");
    await page.waitForTimeout(300);

    await typeViaKeys(page, "sys");
    await expect(page.locator("#autocomplete-bar")).not.toHaveClass(/hidden/, { timeout: 2000 });

    // The command chip appears...
    await expect(page.locator(".ac-chip", { hasText: /^systemctl$/ })).toBeVisible({ timeout: 2000 });

    // ...and the first chip is the command, not a dictionary word.
    var firstText = await page.locator(".ac-chip").first().textContent();
    expect(firstText.trim()).toBe("systemctl");

    await result.context.close();
});
