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

async function waitForTerminalReady(page) {
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(1500);
}

async function newTouchPage(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    return { context: context, page: page };
}

async function showKeyboard(page) {
    // Tapping the terminal shows the on-screen (JS) keyboard.
    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);
}

async function keyboardHidden(page) {
    return await page.locator("#touch-keyboard").evaluate((el) => el.classList.contains("hidden"));
}

test("Keyboard shown -> select -> Done -> keyboard shown again", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);

    await showKeyboard(page);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 3000 });

    await page.locator("#select-btn").tap();
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });
    // Keyboard hides behind the overlay while selecting.
    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/, { timeout: 3000 });

    await page.locator("#select-done-btn").tap();
    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    // Keyboard should be restored to its prior shown state.
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 3000 });

    await context.close();
});

test("Keyboard shown -> paste -> Cancel -> keyboard shown again", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);

    await showKeyboard(page);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 3000 });

    await page.locator("#paste-btn").tap();
    await expect(page.locator("#paste-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });
    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/, { timeout: 3000 });

    await page.locator("#paste-cancel-btn").tap();
    await expect(page.locator("#paste-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 3000 });

    await context.close();
});

test("Keyboard hidden -> select -> Done -> keyboard stays hidden", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);

    // Keyboard starts hidden; do not show it.
    expect(await keyboardHidden(page)).toBe(true);

    await page.locator("#select-btn").tap();
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });

    await page.locator("#select-done-btn").tap();
    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    // Must not force-show the keyboard.
    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/, { timeout: 3000 });

    await context.close();
});
