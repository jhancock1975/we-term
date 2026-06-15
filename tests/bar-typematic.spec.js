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

async function ready(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    await page.addInitScript(WS_INTERCEPT_SCRIPT);
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(500);
    return { context: context, page: page };
}

function countInputs(sent, data) {
    return sent
        .map((m) => { try { return JSON.parse(m); } catch (e) { return null; } })
        .filter((m) => m && m.type === "input" && m.data === data)
        .length;
}

async function holdTouch(page, selector, holdMs) {
    var b = await page.locator(selector).boundingBox();
    var pt = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    await page.evaluate((pt) => {
        var el = document.elementFromPoint(pt.x, pt.y);
        window.__barEl = el;
        var t = new Touch({ identifier: 1, target: el, clientX: pt.x, clientY: pt.y });
        el.dispatchEvent(new TouchEvent("touchstart", {
            cancelable: true, bubbles: true, touches: [t], targetTouches: [t], changedTouches: [t],
        }));
    }, pt);
    await page.waitForTimeout(holdMs);
    await page.evaluate((pt) => {
        var el = window.__barEl;
        var t = new Touch({ identifier: 1, target: el, clientX: pt.x, clientY: pt.y });
        el.dispatchEvent(new TouchEvent("touchend", {
            cancelable: true, bubbles: true, touches: [], targetTouches: [], changedTouches: [t],
        }));
    }, pt);
}

test("holding the Up arrow in the button bar repeats the keystroke", async ({ browser, browserName }) => {
    test.skip(browserName !== "chromium", "synthetic TouchEvent constructor unsupported in Playwright WebKit");
    var result = await ready(browser);
    var page = result.page;

    await holdTouch(page, '#button-scroll [data-key="up"]', 1300);
    await page.waitForTimeout(100);

    // 500ms hold + 500ms repeat over 1300ms -> at least 2 Up sequences.
    var count = await page.evaluate(() => window.__wsSent || []).then((sent) => countInputs(sent, "\x1b[A"));
    expect(count).toBeGreaterThanOrEqual(2);

    await result.context.close();
});

test("a quick tap on a bar arrow sends exactly one keystroke", async ({ browser }) => {
    var result = await ready(browser);
    var page = result.page;

    await page.locator('#button-scroll [data-key="down"]').tap();
    await page.waitForTimeout(150);

    var count = await page.evaluate(() => window.__wsSent || []).then((sent) => countInputs(sent, "\x1b[B"));
    expect(count).toBe(1);

    await result.context.close();
});
