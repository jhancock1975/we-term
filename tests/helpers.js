const { spawn } = require("child_process");
const path = require("path");

const TEST_PORT = 19090;
const TEST_HOST = "127.0.0.1";
const TEST_BASE_URL = "http://" + TEST_HOST + ":" + TEST_PORT;

function startServer() {
    var venvPython = path.join(__dirname, "..", "venv", "bin", "python");
    var serverScript = path.join(__dirname, "..", "server.py");

    var proc = spawn(venvPython, [serverScript], {
        cwd: path.join(__dirname, ".."),
        stdio: "pipe",
        env: Object.assign({}, process.env, {
            WETERM_HOST: TEST_HOST,
            WETERM_PORT: String(TEST_PORT),
        }),
    });

    return proc;
}

async function waitForServer(proc) {
    return new Promise(function (resolve) {
        proc.stderr.on("data", function (data) {
            if (data.toString().includes("Running on")) resolve();
        });
        setTimeout(resolve, 3000);
    });
}

async function stopServer(proc) {
    if (proc) {
        proc.kill("SIGKILL");
        await new Promise(function (resolve) {
            proc.on("close", resolve);
            setTimeout(resolve, 2000);
        });
    }
}

module.exports = {
    TEST_PORT: TEST_PORT,
    TEST_HOST: TEST_HOST,
    TEST_BASE_URL: TEST_BASE_URL,
    startServer: startServer,
    waitForServer: waitForServer,
    stopServer: stopServer,
};
