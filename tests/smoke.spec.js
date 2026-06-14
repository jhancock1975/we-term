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

// ---------------------------------------------------------------------------
// Unit tests: critical DOM elements exist at load time
// ---------------------------------------------------------------------------

test("All critical DOM elements exist after page load", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });

    var elements = await page.evaluate(() => {
        var ids = [
            "terminal",
            "toast",
            "settings-panel",
            "select-overlay",
            "select-toolbar",
            "select-copy-btn",
            "select-done-btn",
            "select-content",
            "select-label",
            "paste-overlay",
            "paste-area",
            "paste-send-btn",
            "paste-cancel-btn",
            "button-bar",
            "button-scroll",
            "touch-keyboard",
            "touch-key-preview",
            "settings-btn",
            "select-btn",
            "paste-btn",
        ];
        var results = {};
        ids.forEach(function (id) {
            results[id] = !!document.getElementById(id);
        });
        return results;
    });

    for (var id in elements) {
        expect(elements[id], "Element #" + id + " should exist").toBe(true);
    }
});

test("No JavaScript errors during page load", async ({ browser }) => {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    var jsErrors = [];

    page.on("pageerror", function (error) {
        jsErrors.push(error.message);
    });

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(2000);

    expect(jsErrors).toEqual([]);

    await context.close();
});

test("No JavaScript errors during touch interaction", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;
    var jsErrors = [];

    page.on("pageerror", function (error) {
        jsErrors.push(error.message);
    });

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(500);

    expect(jsErrors).toEqual([]);

    await context.close();
});

// ---------------------------------------------------------------------------
// Hypothesis tests: system keyboard suppression
// ---------------------------------------------------------------------------

test("Touch device: xterm helper textarea is readonly with inputmode=none", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(500);

    var helperState = await page.evaluate(() => {
        var textarea = document.querySelector("#terminal .xterm-helper-textarea");
        if (!textarea) return null;
        return {
            disabled: textarea.disabled,
            pointerEvents: textarea.style.pointerEvents,
            readOnly: textarea.readOnly,
            inputMode: textarea.getAttribute("inputmode"),
        };
    });

    expect(helperState).not.toBeNull();
    expect(helperState.disabled).toBe(true);
    expect(helperState.pointerEvents).toBe("none");
    expect(helperState.readOnly).toBe(true);
    expect(helperState.inputMode).toBe("none");

    await context.close();
});

test("Touch device: tapping terminal shows custom keyboard", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(500);

    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 3000 });

    var keyCount = await page.locator(".touch-key").count();
    expect(keyCount).toBeGreaterThan(20);

    await context.close();
});

test("Non-touch device: custom keyboard stays hidden", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator("#terminal .xterm-screen").click();
    await page.waitForTimeout(500);

    await expect(page.locator("#touch-keyboard")).toHaveClass(/hidden/);
});

test("Touch device: Esc lives in the button bar (left of Ctrl), not on the keyboard", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(500);

    // Esc lives in the button bar now, immediately to the left of Ctrl.
    var barEsc = await page.locator('#button-bar [data-key="escape"]').count();
    expect(barEsc).toBe(1);

    var order = await page.locator("#button-scroll .bar-btn").evaluateAll((btns) => {
        return btns.map(function (b) {
            return b.getAttribute("data-modifier") || b.getAttribute("data-key") || b.getAttribute("data-action");
        });
    });
    var ctrlIdx = order.indexOf("ctrl");
    var escIdx = order.indexOf("escape");
    expect(escIdx).toBeGreaterThanOrEqual(0);
    expect(ctrlIdx).toBe(escIdx + 1);

    // Esc was removed from the on-screen keyboard's letters mode.
    var kbEsc = await page.locator('#touch-keyboard [data-touch-key="escape"]').count();
    expect(kbEsc).toBe(0);

    await context.close();
});

test("Button bar has no Enter button (Enter is only on touch keyboard)", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(1500);

    var barEnter = await page.locator('#button-bar [data-key="enter"]').count();
    expect(barEnter).toBe(0);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(500);

    var kbEnter = await page.locator('#touch-keyboard [data-touch-key="enter"]').count();
    expect(kbEnter).toBe(1);

    await context.close();
});

// ---------------------------------------------------------------------------
// End-to-end: terminal renders content
// ---------------------------------------------------------------------------

test("Terminal renders visible content after page load", async ({ page }) => {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });

    await expect.poll(async () => {
        return await page.evaluate(() => {
            var screen = document.querySelector("#terminal .xterm-screen");
            return screen ? screen.textContent.trim().length : 0;
        });
    }, { timeout: 10000 }).toBeGreaterThan(0);
});

test("Terminal renders content on touch device", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });

    await expect.poll(async () => {
        return await page.evaluate(() => {
            var screen = document.querySelector("#terminal .xterm-screen");
            return screen ? screen.textContent.trim().length : 0;
        });
    }, { timeout: 10000 }).toBeGreaterThan(0);

    await context.close();
});

test("Terminal is not obscured by overlays at startup", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(1500);

    var overlayStates = await page.evaluate(() => {
        return {
            selectOverlayHidden: document.getElementById("select-overlay").classList.contains("hidden"),
            pasteOverlayHidden: document.getElementById("paste-overlay").classList.contains("hidden"),
            settingsPanelHidden: document.getElementById("settings-panel").classList.contains("hidden"),
        };
    });

    expect(overlayStates.selectOverlayHidden).toBe(true);
    expect(overlayStates.pasteOverlayHidden).toBe(true);
    expect(overlayStates.settingsPanelHidden).toBe(true);

    await context.close();
});

test("Select overlay toolbar has Copy and Done buttons", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(1500);

    var toolbarState = await page.evaluate(() => {
        var copyBtn = document.getElementById("select-copy-btn");
        var doneBtn = document.getElementById("select-done-btn");
        var label = document.getElementById("select-label");
        return {
            copyExists: !!copyBtn,
            copyText: copyBtn ? copyBtn.textContent.trim() : null,
            doneExists: !!doneBtn,
            doneText: doneBtn ? doneBtn.textContent.trim() : null,
            labelExists: !!label,
            labelText: label ? label.textContent.trim() : null,
        };
    });

    expect(toolbarState.copyExists).toBe(true);
    expect(toolbarState.copyText).toBe("Copy");
    expect(toolbarState.doneExists).toBe(true);
    expect(toolbarState.doneText).toBe("Done");
    expect(toolbarState.labelExists).toBe(true);
    expect(toolbarState.labelText).toBe("Select text, then tap Copy");

    await context.close();
});

// ---------------------------------------------------------------------------
// Regression: touch keyboard survives missing select overlay elements
// ---------------------------------------------------------------------------

test("Touch keyboard works even if select overlay buttons are missing (cache mismatch)", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;
    var jsErrors = [];

    page.on("pageerror", function (error) {
        jsErrors.push(error.message);
    });

    await page.addInitScript(() => {
        document.addEventListener("DOMContentLoaded", function () {
            var btn = document.getElementById("select-copy-btn");
            if (btn) btn.remove();
            var done = document.getElementById("select-done-btn");
            if (done) done.remove();
        });
    });

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(1500);

    expect(jsErrors).toEqual([]);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(500);

    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 3000 });

    var helperState = await page.evaluate(() => {
        var textarea = document.querySelector("#terminal .xterm-helper-textarea");
        return textarea ? { disabled: textarea.disabled, pointerEvents: textarea.style.pointerEvents } : null;
    });
    expect(helperState).not.toBeNull();
    expect(helperState.disabled).toBe(true);
    expect(helperState.pointerEvents).toBe("none");

    await context.close();
});

// ---------------------------------------------------------------------------
// Cache busting: server sends no-cache headers
// ---------------------------------------------------------------------------

test("Server sends no-cache headers for static files", async ({ page }) => {
    var response = await page.goto("/");
    var cacheControl = response.headers()["cache-control"];
    expect(cacheControl).toContain("no-cache");

    var jsResponse = await page.request.get("/static/terminal.js");
    var jsCacheControl = jsResponse.headers()["cache-control"];
    expect(jsCacheControl).toContain("no-cache");

    var cssResponse = await page.request.get("/static/style.css");
    var cssCacheControl = cssResponse.headers()["cache-control"];
    expect(cssCacheControl).toContain("no-cache");
});

test("index.html references terminal.js and style.css with a cache-busting version", async ({ page }) => {
    var response = await page.goto("/");
    var html = await response.text();

    var jsMatch = html.match(/\/static\/terminal\.js\?v=([a-zA-Z0-9]+)/);
    var cssMatch = html.match(/\/static\/style\.css\?v=([a-zA-Z0-9]+)/);

    expect(jsMatch, "terminal.js should have ?v= version").not.toBeNull();
    expect(cssMatch, "style.css should have ?v= version").not.toBeNull();

    // The versioned URL must actually serve the file.
    var jsResponse = await page.request.get("/static/terminal.js?v=" + jsMatch[1]);
    expect(jsResponse.status()).toBe(200);
});

test("cache-busting ?v= equals the content hash of terminal.js + style.css", async ({ page }) => {
    var crypto = require("crypto");
    var fs = require("fs");
    var path = require("path");

    var dir = path.join(__dirname, "..", "static");
    var h = crypto.createHash("sha1");
    h.update(fs.readFileSync(path.join(dir, "terminal.js")));
    h.update(fs.readFileSync(path.join(dir, "style.css")));
    var expected = h.digest("hex").slice(0, 12);

    var response = await page.goto("/");
    var html = await response.text();

    var jsMatch = html.match(/\/static\/terminal\.js\?v=([a-zA-Z0-9]+)/);
    var cssMatch = html.match(/\/static\/style\.css\?v=([a-zA-Z0-9]+)/);

    expect(jsMatch, "terminal.js should have ?v= version").not.toBeNull();
    expect(cssMatch, "style.css should have ?v= version").not.toBeNull();

    // The served version must equal the content hash, so it changes when the
    // asset content changes -- the whole point of cache-busting.
    expect(jsMatch[1]).toBe(expected);
    // Both assets share the same content-derived token.
    expect(cssMatch[1]).toBe(expected);
});

// ---------------------------------------------------------------------------
// End-to-end: typing works after tap on touch device
// ---------------------------------------------------------------------------

test("Touch keyboard sends keystrokes to terminal after tap", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var context = result.context;
    var page = result.page;

    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(1500);

    await page.locator("#terminal .xterm-screen").tap();
    await page.waitForTimeout(500);
    await expect(page.locator("#touch-keyboard")).not.toHaveClass(/hidden/, { timeout: 3000 });

    await page.locator('[data-touch-key="e"]').tap();
    await page.locator('[data-touch-key="c"]').tap();
    await page.locator('[data-touch-key="h"]').tap();
    await page.locator('[data-touch-key="o"]').tap();
    await page.locator('[data-touch-key="space"]').tap();
    await page.locator('[data-touch-key="shift"]').tap();
    await page.locator('[data-touch-key="h"]').tap();
    await page.locator('[data-touch-key="i"]').tap();
    await page.locator('[data-touch-key="enter"]').tap();
    await page.waitForTimeout(1000);

    await expect.poll(async () => {
        return await page.evaluate(() => {
            var screen = document.querySelector("#terminal .xterm-screen");
            return screen ? screen.textContent : "";
        });
    }, { timeout: 5000 }).toContain("Hi");

    await context.close();
});
