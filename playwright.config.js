const { defineConfig } = require("@playwright/test");

const TEST_PORT = 19090;

module.exports = defineConfig({
    testDir: "./tests",
    timeout: 30000,
    workers: 1,
    use: {
        baseURL: "http://127.0.0.1:" + TEST_PORT,
        headless: true,
    },
    projects: [
        {
            name: "chromium",
            use: { browserName: "chromium" },
        },
    ],
});
