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

test("POST /complete returns shell command candidates", async ({ request }) => {
    var res = await request.post("/complete", { data: { line: "gi" } });
    var body = await res.json();
    expect(Array.isArray(body.candidates)).toBe(true);
    expect(body.candidates).toContain("git"); // compgen -c
});

test("Server file completion suggests files in the shell's cwd", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    // compgen -f runs in the live shell's cwd, which for the test server is the
    // repo root -> "ser" completes to "server.py".
    await typeViaKeys(page, "cat ser");
    var chip = page.locator(".ac-chip", { hasText: /^server\.py$/ });
    await expect(chip).toBeVisible({ timeout: 5000 });

    // Tapping inserts the whole completed line + a trailing space.
    await page.evaluate(() => { window.__wsSent = []; });
    await chip.tap();
    await page.waitForTimeout(200);
    var combined = inputs(await page.evaluate(() => window.__wsSent)).join("");
    expect(combined).toContain("cat server.py ");

    await result.context.close();
});

test("Command completion can be turned off in Settings", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    // On by default: typing shows the bar.
    await typeViaKeys(page, "gi");
    await expect(page.locator("#autocomplete-bar")).not.toHaveClass(/hidden/, { timeout: 2000 });

    // Turn the setting off.
    await page.locator("#settings-btn").tap();
    await expect(page.locator("#settings-panel")).not.toHaveClass(/hidden/, { timeout: 2000 });
    await expect(page.locator("#autocomplete-toggle")).toBeChecked();
    await page.locator("#autocomplete-toggle").uncheck();
    await page.locator("#settings-close-btn").tap();
    await expect(page.locator("#settings-panel")).toHaveClass(/hidden/, { timeout: 2000 });

    // Re-show the keyboard and type: no suggestion bar now.
    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(200);
    await typeViaKeys(page, "gi");
    await page.waitForTimeout(400);
    await expect(page.locator("#autocomplete-bar")).toHaveClass(/hidden/);

    await result.context.close();
});

test("Suggestion strip persists (no resize churn) and shows recent history after Enter", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    await typeViaKeys(page, "echo persist\n");
    await page.waitForTimeout(400);

    // The strip stays visible (fixed-height persistent bar) and lists the
    // just-run command from history rather than collapsing the layout.
    await expect(page.locator("#autocomplete-bar")).not.toHaveClass(/hidden/);
    await expect(page.locator(".ac-chip", { hasText: /^echo persist$/ })).toBeVisible();

    await result.context.close();
});

test("No suggestions while a password prompt is shown", async ({ browser }) => {
    var result = await newTouchPage(browser, false);
    var page = result.page;
    await gotoReady(page);

    // Seed history so the strip would otherwise have something to show.
    await typeViaKeys(page, "echo seed\n");
    await page.waitForTimeout(300);

    // A silent read whose prompt line contains "password".
    await typeViaKeys(page, "read -sp password x\n");
    await page.waitForTimeout(500);

    // Strip must be hidden while the password prompt is on screen.
    await expect(page.locator("#autocomplete-bar")).toHaveClass(/hidden/, { timeout: 3000 });

    // Typing during the prompt still shows nothing.
    await typeViaKeys(page, "se");
    await page.waitForTimeout(300);
    await expect(page.locator("#autocomplete-bar")).toHaveClass(/hidden/);

    // Finish the read to return to a normal prompt.
    await page.locator('[data-touch-key="enter"]').tap();
    await result.context.close();
});
