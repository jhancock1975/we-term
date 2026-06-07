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

// Type a string by tapping the on-screen keyboard keys (the realistic path,
// since the xterm textarea is intentionally un-focusable on touch).
async function typeViaKeys(page, str) {
    for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        if (ch === "\n" || ch === "\r") {
            await page.locator('[data-touch-key="enter"]').tap();
        } else if (ch === " ") {
            await page.locator('[data-touch-key="space"]').tap();
        } else if (ch >= "A" && ch <= "Z") {
            await page.locator('[data-touch-key="shift"]').tap();
            await page.locator('[data-touch-key="' + ch.toLowerCase() + '"]').tap();
        } else {
            await page.locator('[data-touch-key="' + ch + '"]').tap();
        }
        await page.waitForTimeout(60);
    }
}

// Rendered terminal text only (excludes xterm's injected <style> element that
// lives inside .xterm-screen and would otherwise pollute text matches).
async function screenText(page) {
    return await page.evaluate(() => {
        var rows = document.querySelector("#terminal .xterm-rows");
        if (!rows) return "";
        return Array.from(rows.children).map(function (r) { return r.textContent; }).join("\n");
    });
}

async function cursorState(page) {
    return await page.evaluate(() => {
        var cur = document.getElementById("touch-cursor");
        var term = document.getElementById("terminal");
        if (!cur || !term) {
            return { exists: false };
        }
        var cs = getComputedStyle(cur);
        var cbox = cur.getBoundingClientRect();
        var tbox = term.getBoundingClientRect();
        var visible = !cur.classList.contains("hidden") && cs.display !== "none" && cs.visibility !== "hidden" && cbox.width > 0 && cbox.height > 0;
        var insideTerminal = cbox.left >= tbox.left - 2 && cbox.right <= tbox.right + 2 && cbox.top >= tbox.top - 2 && cbox.bottom <= tbox.bottom + 2;
        return {
            exists: true,
            visible: visible,
            insideTerminal: insideTerminal,
            left: Math.round(cbox.left),
            top: Math.round(cbox.top),
            width: Math.round(cbox.width),
            height: Math.round(cbox.height),
            animationName: cs.animationName,
        };
    });
}

async function gotoReady(page) {
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#terminal .xterm-screen").textContent.trim().length > 0, {}, { timeout: 10000 });
    await page.waitForTimeout(1000);
    await page.locator("#terminal .xterm-screen").tap(); // show keyboard
    await page.waitForTimeout(400);
}

test("Blinking cursor is visible at the shell prompt", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    var state = await cursorState(page);
    expect(state.exists, "#touch-cursor element should exist").toBe(true);
    expect(state.visible, "cursor should be visible").toBe(true);
    expect(state.insideTerminal, "cursor should be within the terminal").toBe(true);
    expect(state.animationName).not.toBe("none"); // blinking

    await result.context.close();
});

test("Cursor is visible and tracks position in a node REPL", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    var before = await cursorState(page);

    await typeViaKeys(page, "node\n");
    await expect.poll(async () => {
        return await screenText(page);
    }, { timeout: 10000 }).toContain(">");
    await page.waitForTimeout(500);

    var inNode = await cursorState(page);
    expect(inNode.visible, "cursor visible in node REPL").toBe(true);
    expect(inNode.insideTerminal).toBe(true);
    // Cursor should have moved relative to the empty shell prompt position.
    expect(inNode.left !== before.left || inNode.top !== before.top).toBe(true);

    // The server keeps ONE persistent session shared across connections, so
    // leave it at a clean shell prompt for subsequent tests (.exit quits node).
    await typeViaKeys(page, ".exit\n");
    await page.waitForTimeout(800);

    await result.context.close();
});

test("Cursor is visible in emacs (full-screen TUI)", async ({ browser }) => {
    var result = await newTouchPage(browser);
    var page = result.page;
    await gotoReady(page);

    await typeViaKeys(page, "emacs -nw -Q\n");
    // Wait for emacs to paint its UI (mode line / scratch buffer text).
    await expect.poll(async () => {
        return await screenText(page);
    }, { timeout: 25000 }).toMatch(/scratch|Lisp Interaction|This buffer/i);
    await page.waitForTimeout(800);

    var state = await cursorState(page);
    expect(state.visible, "cursor visible in emacs").toBe(true);
    expect(state.insideTerminal).toBe(true);

    await result.context.close();
});
