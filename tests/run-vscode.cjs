"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-bridge-vscode-"));
const workspace = path.join(testRoot, "workspace");
const result = path.join(testRoot, "result.json");
fs.mkdirSync(workspace);
async function main() {
const installed = process.platform === "win32" && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs/Microsoft VS Code/Code.exe") : undefined;
const executable = process.env.VSCODE_EXECUTABLE || (installed && fs.existsSync(installed) ? installed : await require("@vscode/test-electron").downloadAndUnzipVSCode("stable"));
const args = [workspace, "--new-window", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust", "--disable-extensions",
 "--user-data-dir=" + path.join(testRoot, "profile"), "--extensions-dir=" + path.join(testRoot, "extensions"),
 "--extensionDevelopmentPath=" + root, "--extensionTestsPath=" + path.join(root, "tests/vscode/runner.cjs")];
const child = spawn(executable, args, { env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, BRIDGE_TEST_RESULT: result }, windowsHide: true, stdio: "inherit" });
const timeout = setTimeout(() => { child.kill(); console.error("VS Code integration timeout; artifacts: " + testRoot); process.exitCode = 1; }, 180000);
child.on("error", error => { clearTimeout(timeout); console.error(error); process.exitCode = 1; });
child.on("exit", code => {
 clearTimeout(timeout);
 const report = fs.existsSync(result) ? JSON.parse(fs.readFileSync(result, "utf8")) : { passed: false, error: "No native test report" };
 console.log(JSON.stringify(report, null, 2));
 console.log("Integration artifacts: " + testRoot);
 if (code !== 0 || !report.passed) process.exitCode = 1;
});
}
main().catch(error => { console.error(error); process.exitCode = 1; });
