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

async function newTouchPage(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    return { context: context, page: page };
}

async function gotoReady(page) {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(
        () => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0,
        {}, { timeout: 10000 }
    );
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
        } else if (ch === "-") {
            await page.locator('[data-touch-key="-"]').tap();
        } else {
            await page.locator('[data-touch-key="' + ch + '"]').tap();
        }
        await page.waitForTimeout(45);
    }
}

const SECRET = "topsecretpw";

// The real shell enters a hidden-input mode (ECHO off, ICANON on) during a
// `read -s`. A typed password must never be tracked into command history nor
// shown as an autocomplete suggestion.
test("password typed at a hidden-input (read -s) prompt never enters history or suggestions", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    // Start a hidden-input read in the real shell.
    await typeViaKeys(page, "read -s -p pw x\n");
    // Give the server time to observe the termios change and notify the client.
    await page.waitForTimeout(700);

    // While the hidden read is active, the suggestion bar must be hidden.
    await expect(page.locator("#autocomplete-bar")).toHaveClass(/hidden/);

    // Type the secret + Enter.
    await typeViaKeys(page, SECRET + "\n");
    await page.waitForTimeout(400);

    // The secret must not be in persisted history.
    var history = await page.evaluate(() => {
        try { return JSON.parse(localStorage.getItem("we-term-history") || "[]"); }
        catch (e) { return []; }
    });
    expect(history.join("\n")).not.toContain(SECRET);

    // And bringing the empty-line suggestion strip up must not surface it.
    var chips = await page.locator("#autocomplete-bar .ac-chip").allTextContents();
    expect(chips.join("\n")).not.toContain(SECRET);

    await result.context.close();
});
