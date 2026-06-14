const { test, expect } = require("@playwright/test");
const { startServer, waitForServer, stopServer, TEST_BASE_URL } = require("./helpers");

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
    await page.locator("#terminal .xterm-screen").tap();
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
        await page.waitForTimeout(45);
    }
}

test("/history endpoint returns a history array", async ({ request }) => {
    var res = await request.get(TEST_BASE_URL + "/history");
    expect(res.ok()).toBeTruthy();
    var body = await res.json();
    expect(Array.isArray(body.history)).toBeTruthy();
});

test("a just-run command shows in suggestions and is never persisted to localStorage", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    await typeViaKeys(page, "echo zzmarker\n");
    await page.waitForTimeout(700);

    // The empty-line suggestion strip lists the just-run command.
    var chips = await page.locator("#autocomplete-bar .ac-chip").allTextContents();
    expect(chips.join("\n")).toContain("echo zzmarker");

    // History is sourced from the shell, never persisted client-side.
    var legacy = await page.evaluate(() => localStorage.getItem("we-term-history"));
    expect(legacy).toBeNull();

    await result.context.close();
});
