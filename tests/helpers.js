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
    var url = TEST_BASE_URL + "/";
    var exited = false;
    proc.on("exit", function () { exited = true; });
    var deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        if (exited) {
            throw new Error("server process exited before becoming ready");
        }
        try {
            var res = await fetch(url);
            if (res.ok) return;
        } catch (e) {
            // not listening yet
        }
        await new Promise(function (r) { setTimeout(r, 150); });
    }
    throw new Error("server did not become ready at " + url + " within 15s");
}

async function stopServer(proc) {
    if (!proc) return;
    // Graceful SIGTERM first so aiohttp releases the listening socket before
    // the next spec file binds the same port; SIGKILL only as a fallback.
    await new Promise(function (resolve) {
        var done = false;
        function finish() { if (!done) { done = true; resolve(); } }
        proc.on("close", finish);
        try { proc.kill("SIGTERM"); } catch (e) { /* already gone */ }
        setTimeout(function () {
            try { proc.kill("SIGKILL"); } catch (e) { /* already gone */ }
            setTimeout(finish, 500);
        }, 1500);
    });
}

module.exports = {
    TEST_PORT: TEST_PORT,
    TEST_HOST: TEST_HOST,
    TEST_BASE_URL: TEST_BASE_URL,
    startServer: startServer,
    waitForServer: waitForServer,
    stopServer: stopServer,
};
