const { test, expect } = require("@playwright/test");
const { startServer, waitForServer, stopServer } = require("./helpers");

let serverProcess;
test.beforeAll(async () => { serverProcess = startServer(); await waitForServer(serverProcess); });
test.afterAll(async () => { await stopServer(serverProcess); });

async function ready(browser) {
    var context = await browser.newContext({ hasTouch: true });
    var page = await context.newPage();
    await page.goto("/");
    await page.waitForSelector("#terminal .xterm-screen", { timeout: 10000 });
    await page.waitForTimeout(400);
    return { context, page };
}

test("matcher: a path through t-h-e-n yields 'then' as a top candidate", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(
        ["t","h","e","n"], window.GLIDE_WORDS
    ));
    expect(result).toContain("then");
    await context.close();
});

test("matcher: endpoints filter - path g-o-o-d returns 'good' but not 'the'", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(
        ["g","o","o","d"], window.GLIDE_WORDS
    ));
    expect(result).toContain("good");
    expect(result).not.toContain("the");
    await context.close();
});

test("matcher: returns at most 3 candidates", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(
        ["t","h","e","r","e"], window.GLIDE_WORDS
    ));
    expect(result.length).toBeLessThanOrEqual(3);
    await context.close();
});

test("matcher: returns [] for a path shorter than 2 keys", async ({ browser }) => {
    const { context, page } = await ready(browser);
    const result = await page.evaluate(() => window.__glideCandidates(["t"], window.GLIDE_WORDS));
    expect(result).toEqual([]);
    await context.close();
});
