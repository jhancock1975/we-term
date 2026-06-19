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

async function newTouchPage(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    return { context: context, page: page };
}

async function waitForTerminalReady(page) {
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(1500);
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

test("Select content renders like the terminal (pre, no word-break, matching line-height)", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await waitForTerminalReady(page);
    await ensureTouchTerminalOutput(page);

    // Echo a known string so we can verify content is unchanged.
    var marker = "copyrendermarker123";
    await typeInTerminal(page, "echo " + marker);
    await page.waitForFunction((m) => {
        var rows = document.querySelector("#terminal .xterm-rows");
        return !!rows && rows.textContent.indexOf(m) !== -1;
    }, marker, { timeout: 10000 });

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);

    await page.locator("#select-btn").tap();
    await expect(page.locator("#select-overlay")).not.toHaveClass(/hidden/, { timeout: 3000 });

    // Presentation: must match the terminal layout, not reflow.
    var styles = await page.locator("#select-content").evaluate((el) => {
        var cs = getComputedStyle(el);
        var fontSize = parseFloat(cs.fontSize);
        var lineHeight = cs.lineHeight === "normal" ? fontSize : parseFloat(cs.lineHeight);
        return {
            whiteSpace: cs.whiteSpace,
            wordBreak: cs.wordBreak,
            fontSize: fontSize,
            lineHeight: lineHeight,
        };
    });

    expect(styles.whiteSpace).toBe("pre");
    expect(styles.wordBreak).toBe("normal");
    expect(styles.fontSize).toBeCloseTo(14, 1);
    // line-height ~14px (1.0), NOT 1.4*14 ≈ 19.6px.
    expect(styles.lineHeight).toBeGreaterThanOrEqual(13);
    expect(styles.lineHeight).toBeLessThanOrEqual(15);

    // Content unchanged: the echoed string is present in the select overlay.
    var selectText = await page.locator("#select-content").evaluate((el) => el.textContent);
    expect(selectText).toContain(marker);

    // Dismiss the in-place overlay by tapping away (no Done button).
    await page.waitForTimeout(500);
    await page.evaluate(() => { var s = window.getSelection(); if (s) s.removeAllRanges(); });
    await page.locator("#select-overlay").tap();
    await expect(page.locator("#select-overlay")).toHaveClass(/hidden/, { timeout: 3000 });

    await context.close();
});
