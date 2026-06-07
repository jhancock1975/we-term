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

async function gotoReady(page) {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(800);
}

test("Settings has a 'Use system keyboard' toggle, off by default", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    var toggle = page.locator("#system-keyboard-toggle");
    await expect(toggle).toHaveCount(1);
    expect(await toggle.isChecked()).toBe(false);

    // Default mode: tapping the terminal shows the JS keyboard.
    await page.locator("#terminal .xterm-screen").tap();
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 2000 });

    await result.context.close();
});

test("System keyboard mode: tap keeps JS keyboard hidden and textarea is focusable", async ({ browser }) => {
    var result = await newTouchPage(browser, true);
    var page = result.page;
    await gotoReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(400);

    // JS keyboard must stay hidden in system-keyboard mode.
    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/);

    // The xterm textarea must be a real, focusable input (so iOS shows its
    // keyboard) - not the locked-down version used for the JS keyboard.
    var ta = await page.evaluate(() => {
        var t = document.querySelector("#terminal .xterm-helper-textarea");
        return t ? { disabled: t.disabled, readOnly: t.readOnly, inputMode: t.getAttribute("inputmode") } : null;
    });
    expect(ta).not.toBeNull();
    expect(ta.disabled).toBe(false);
    expect(ta.readOnly).toBe(false);
    expect(ta.inputMode).not.toBe("none");

    await result.context.close();
});

test("System keyboard mode: gear icon appears on tap and opens settings", async ({ browser }) => {
    var result = await newTouchPage(browser, true);
    var page = result.page;
    await gotoReady(page);

    await expect(page.locator("#keyboard-gear")).toHaveClass(/hidden/);

    await page.locator("#terminal .xterm-screen").tap();
    await expect(page.locator("#keyboard-gear")).not.toHaveClass(/hidden/, { timeout: 2000 });

    await page.locator("#keyboard-gear").tap();
    await expect(page.locator("#settings-panel")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await expect(page.locator("#system-keyboard-toggle")).toBeChecked();

    await result.context.close();
});

test("System keyboard mode: typing through the focused textarea reaches the PTY", async ({ browser }) => {
    var result = await newTouchPage(browser, true);
    var page = result.page;
    await gotoReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(300);
    await page.keyboard.type("echo SYSKB_OK\n");

    await expect.poll(async () => {
        return await page.evaluate(() => {
            var rows = document.querySelector("#terminal .xterm-rows");
            return rows ? Array.from(rows.children).map((r) => r.textContent).join("\n") : "";
        });
    }, { timeout: 6000 }).toContain("SYSKB_OK");

    await result.context.close();
});

test("System keyboard mode: tapping a button-bar button does not show the JS keyboard", async ({ browser }) => {
    var result = await newTouchPage(browser, true);
    var page = result.page;
    await gotoReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/);

    // Tapping a modifier (Ctrl) in the button bar must NOT pop the JS keyboard
    // above the system keyboard.
    await page.locator('[data-modifier="ctrl"]').tap();
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/);

    // An arrow key likewise must not show it.
    await page.locator('#button-bar [data-key="up"]').tap();
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/);

    await result.context.close();
});

test("System keyboard mode: layout constrains to the area above the keyboard", async ({ browser }) => {
    var result = await newTouchPage(browser, true);
    var page = result.page;
    await page.setViewportSize({ width: 390, height: 844 });
    await gotoReady(page);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(300);

    // Simulate the iOS system keyboard appearing by shrinking the viewport.
    await page.setViewportSize({ width: 390, height: 500 });
    await page.waitForTimeout(600);

    var info = await page.evaluate(() => ({
        bodyHeight: document.body.style.height,
        vvHeight: Math.round(window.visualViewport ? window.visualViewport.height : 0),
        termBottom: Math.round(document.getElementById("terminal").getBoundingClientRect().bottom),
        innerHeight: window.innerHeight,
    }));

    // App is constrained to the visible viewport, not the full pre-keyboard height.
    expect(info.bodyHeight).toBe(info.vvHeight + "px");
    // The terminal does not extend below the visible area (i.e. behind the keyboard).
    expect(info.termBottom).toBeLessThanOrEqual(info.innerHeight + 1);

    await result.context.close();
});

test("Toggling 'Use system keyboard' persists the setting", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    await page.locator("#settings-btn").tap();
    await expect(page.locator("#settings-panel")).not.toHaveClass(/hidden/, { timeout: 2000 });
    // Toggling triggers a page reload to reconfigure the textarea; don't let
    // Playwright auto-wait on the navigating click, then wait for the reload.
    await page.locator("#system-keyboard-toggle").click({ noWaitAfter: true });
    await page.waitForLoadState("load");
    await page.waitForTimeout(300);

    var stored = await page.evaluate(() => JSON.parse(localStorage.getItem("we-term-settings") || "{}"));
    expect(stored.systemKeyboard).toBe(true);

    // After the reload it is now in system-keyboard mode: tapping keeps the JS
    // keyboard hidden.
    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(300);
    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/);

    await result.context.close();
});
