"use strict";
const assert = require("node:assert/strict");
const path = require("node:path");
const { connect, RemoteRef } = require("../../client");
async function run() {
 const client = await connect({ workspace: process.env.BRIDGE_TEST_WORKSPACE });
 const call = (target, path, args = [], owned = false) => client.call({ target, path, args, owned });
 try {
  const status = await call("vscode", ["window", "createStatusBarItem"], [1], true);
  await client.set({ target: status, path: ["text"], value: "$(sync~spin) Bridge integration" });
  await call(status, ["show"]);
  assert.equal(await client.get({ target: status, path: ["text"] }), "$(sync~spin) Bridge integration");
  const extension = await call("vscode", ["extensions", "getExtension"], ["Kooraseru.workbench-bridge"]);
  const exported = await call(extension, ["activate"]);
  assert.ok(exported instanceof RemoteRef);
  const sessions = await call(exported, ["getSessions"]);
  assert.equal((await client.snapshot({ target: sessions, path: [] })).length, 1);
  const command = await call("vscode", ["commands", "registerCommand"], ["bridge.test.external", async value => ({ doubled: value * 2 })], true);
  const answer = await call("vscode", ["commands", "executeCommand"], ["bridge.test.external", 21]);
  assert.deepEqual(await client.snapshot({ target: answer, path: [] }), { doubled: 42 });
  const uri = await call("vscode", ["Uri", "file"], [path.join(process.env.BRIDGE_TEST_WORKSPACE, "native.txt")]);
  const bytes = Buffer.from([0, 255, 1, 128, 65]);
  await call("vscode", ["workspace", "fs", "writeFile"], [uri, bytes]);
  assert.deepEqual(await call("vscode", ["workspace", "fs", "readFile"], [uri]), bytes);
  // This API needs no endpoint beyond the existing generic operations.
  const stat = await call("vscode", ["workspace", "fs", "stat"], [uri]);
  assert.equal((await client.snapshot({ target: stat, path: [] })).size, 5);
  await call("vscode", ["workspace", "fs", "writeFile"], [uri, Buffer.from("initial text")]);
  const range = await client.construct({ target: "vscode", path: ["Range"], args: [0, 0, 0, 1] });
  const diagnostic = await client.construct({ target: "vscode", path: ["Diagnostic"], args: [range, "External diagnostic", 1] });
  const collection = await call("vscode", ["languages", "createDiagnosticCollection"], ["bridge-native-test"], true);
  await call(collection, ["set"], [uri, [diagnostic]]);
  assert.equal(await call("vscode", ["commands", "executeCommand"], ["bridge.test.verifyDiagnostic", uri]), true);
  const module = await client.loadModule({ path: "bridge-module.cjs" });
  const typescriptModule = await client.loadModule({ path: "bridge-typescript.mts" });
  assert.equal(await call(typescriptModule, ["name"]), "workspace");
  await client.dispose({ target: typescriptModule });
  let changed;
  const event = new Promise(resolve => { changed = resolve; });
  const subscription = await client.subscribe({ target: "vscode", path: ["workspace", "onDidChangeTextDocument"], callback: async event => {
   const document = await client.get({ target: event, path: ["document"] });
   if (await call(document, ["getText"]) === "edited synchronously") changed();
  } });
  assert.equal(await call(module, ["editDocument"], [uri, "edited synchronously"]), "edited synchronously");
  const timeout = setTimeout(() => changed(new Error("Native event timed out")), 5000);
  try { assert.equal(await event, undefined); } finally { clearTimeout(timeout); }
  await client.unsubscribe({ subscription });
  const provider = await call("vscode", ["languages", "registerCompletionItemProvider"], [
   { scheme: "file", language: "plaintext" }, { provideCompletionItems: async () => [{ label: "external-completion" }] },
  ], true);
  const position = await client.construct({ target: "vscode", path: ["Position"], args: [0, 1] });
  const completions = await call("vscode", ["commands", "executeCommand"], ["vscode.executeCompletionItemProvider", uri, position]);
  const items = await client.get({ target: completions, path: ["items"] });
  const length = await client.get({ target: items, path: ["length"] });
  let found = false;
  for (let i = 0; i < length; i++) if (await client.get({ target: items, path: [String(i), "label"] }) === "external-completion") found = true;
  assert.ok(found, "Async external provider reached native VS Code");
  await assert.rejects(call("vscode", ["commands", "executeCommand"], ["bridge.test.failure"]), /Native fixture failure/);
  for (const target of [provider, module, status, command, collection]) await client.dispose({ target });
  const terminals = await client.get({ target: "vscode", path: ["window", "terminals"] });
  assert.ok((await client.snapshot({ target: terminals, path: [] })).length >= 1);
  await call("vscode", ["window", "createTerminal"], [{ name: "bridge-owned-native", hideFromUser: true }], true);
  console.log("EXTERNAL_NODE_PASS");
 } finally { client.close(); }
}
run().catch(error => { console.error(error.stack); process.exitCode = 1; });
