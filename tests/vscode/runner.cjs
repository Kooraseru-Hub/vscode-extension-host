"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const vscode = require("vscode");
const { listSessions } = require("../../src/discovery");
function child(executable, args, env, cwd) {
 return new Promise((resolve, reject) => {
  const child = spawn(executable, args, { cwd, env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: undefined }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", data => { output += data; console.log(data.toString()); });
  child.stderr.on("data", data => { output += data; console.error(data.toString()); });
  const timeout = setTimeout(() => { child.kill(); reject(new Error("External client timeout: " + output)); }, 60000);
  child.on("error", error => { clearTimeout(timeout); reject(error); });
  child.on("exit", code => { clearTimeout(timeout); if (code === 0) resolve(output); else reject(new Error("External client exit " + code + ": " + output)); });
 });
}
exports.run = async () => {
 const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
 await fs.copyFile(path.join(__dirname, "module.cjs"), path.join(workspace, "bridge-module.cjs"));
 await fs.writeFile(path.join(workspace, "bridge-typescript.mts"), "export function activate(context: { workspaceFolder: {name: string} }) { return { name(): string { return context.workspaceFolder.name; } }; }\n");
 const extension = vscode.extensions.getExtension("Kooraseru.workbench-bridge");
 assert.ok(extension);
 const api = await extension.activate();
 await api.ready;
 assert.equal(vscode.workspace.isTrusted, true);
 const session = listSessions({ workspace }).find(item => item.pid === process.pid);
 assert.ok(session, "Native extension published discovery");
 const disposables = [
  vscode.window.createTerminal({ name: "bridge-borrowed-native", hideFromUser: true }),
  vscode.commands.registerCommand("bridge.test.verifyDiagnostic", uri => vscode.languages.getDiagnostics(uri).some(d => d.message === "External diagnostic")),
  vscode.commands.registerCommand("bridge.test.failure", () => { throw new Error("Native fixture failure"); }),
 ];
 try {
  const env = { WORKBENCH_BRIDGE_SESSION: session.sessionFile, BRIDGE_TEST_WORKSPACE: workspace };
  assert.match(await child(process.env.BRIDGE_TEST_NODE || "node", [path.join(__dirname, "external.cjs")], env), /EXTERNAL_NODE_PASS/);
  const terminalDeadline = Date.now() + 5000;
  while (vscode.window.terminals.some(item => item.name === "bridge-owned-native") && Date.now() < terminalDeadline) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(vscode.window.terminals.some(item => item.name === "bridge-borrowed-native"), "Borrowed native terminal survives disconnect");
  assert.ok(!vscode.window.terminals.some(item => item.name === "bridge-owned-native"), "Owned native terminal is disposed after disconnect");
  assert.match(await child(process.env.BRIDGE_TEST_PYTHON || "python", [path.join(__dirname, "../../examples/python_statusbar.py"), "--once"], env), /connected|status|PASS|shown/i);
  assert.ok(process.env.BRIDGE_TEST_LUTE, "Set BRIDGE_TEST_LUTE to a real Lute executable");
  assert.match(await child(process.env.BRIDGE_TEST_LUTE, [path.join(__dirname, "../../examples/lute_statusbar.luau"), "--once"], env), /connected|status|PASS|shown/i);
  if (process.env.BRIDGE_TEST_TEMPLATE) {
   const { startBridgeServer } = require("../../src/bridge-server");
   const template = process.env.BRIDGE_TEST_TEMPLATE;
   const repoServer = await startBridgeServer({ vscode, extensionContext: { subscriptions: [] }, workspaceFolder: { name: "template", uri: vscode.Uri.file(template) } });
   try {
    const summary = await child(process.env.BRIDGE_TEST_NODE || "node", [path.join(template, "dependencies/packages/editorIntegration/client.cjs")], {
     WORKBENCH_BRIDGE_SESSION: repoServer.sessionFile, WORKBENCH_BRIDGE_ONCE: "1",
    }, template);
    assert.match(summary, /WORKSPACE_READY/);
    console.log("TEMPLATE_NATIVE_CLIENT_PASS");
   } finally { await repoServer.dispose(); }
  }
  console.log("WORKBENCH_BRIDGE_NATIVE_PASS");
  await fs.writeFile(process.env.BRIDGE_TEST_RESULT, JSON.stringify({ passed: true, vscode: vscode.version, clients: ["Node", "Python", "Lute"], cases: ["status", "commands", "exports", "binary", "filesystem", "diagnostics", "events", "sync-edit-module", "async-provider", "native-errors"] }));
 } catch (error) {
  await fs.writeFile(process.env.BRIDGE_TEST_RESULT, JSON.stringify({ passed: false, error: error.stack }));
  throw error;
 } finally {
  for (const disposable of disposables) disposable.dispose();
  await api.dispose();
 }
};
