"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { test } = require("node:test");
const { makeVscode } = require("./mock-vscode");
const { createWorkspaceSetup } = require("../src/workspace-setup");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("runs setup silently after trust and refreshes on watched changes", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "extension-host-setup-"));
	const script = path.join(root, "setup.js");
	await fs.writeFile(script, "// setup fixture\n");
	const vscode = makeVscode([root]);
	let grantTrust;
	vscode.workspace.isTrusted = false;
	vscode.workspace.onDidGrantWorkspaceTrust = (listener) => { grantTrust = listener; return { dispose() {} }; };
	vscode.workspace.getConfiguration = () => ({ get(key, fallback) {
		return ({ workspaceSetupScript: "setup.js", workspaceSetupWatch: ["dependencies/dependencies.toml"] })[key] ?? fallback;
	} });
	const logs = [];
	vscode.window = { createOutputChannel: () => ({ appendLine: (value) => logs.push(value), dispose() {} }) };
	const calls = [];
	const spawn = (command, args, options) => {
		const child = new EventEmitter();
		child.stdout = new PassThrough();
		child.stderr = new PassThrough();
		child.kill = () => {};
		calls.push({ command, args, options });
		setTimeout(() => { child.stdout.end("setup completed\n"); child.emit("close", 0, null); }, 5);
		return child;
	};
	const setup = createWorkspaceSetup(vscode, { spawn, debounceMs: 1 });
	await wait(15);
	assert.equal(calls.length, 0, "untrusted workspaces must not execute setup");
	vscode.workspace.isTrusted = true;
	grantTrust();
	await wait(30);
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, process.execPath);
	assert.deepEqual(calls[0].args, [await fs.realpath(script)]);
	assert.equal(calls[0].options.env.ELECTRON_RUN_AS_NODE, "1");
	assert.equal(calls[0].options.windowsHide, true);
	assert.ok(logs.some((line) => line.includes("setup completed")));
	const manifestWatcher = vscode.watchers.find((item) => item.pattern.pattern === "dependencies/dependencies.toml");
	assert.ok(manifestWatcher);
	manifestWatcher.change.fire({});
	await wait(30);
	assert.equal(calls.length, 2);
	setup.dispose();
	await fs.unlink(script);
	await fs.rmdir(root);
});

test("rejects setup paths outside the workspace", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "extension-host-setup-"));
	const vscode = makeVscode([root]);
	vscode.workspace.isTrusted = true;
	vscode.workspace.getConfiguration = () => ({ get(key, fallback) { return key === "workspaceSetupScript" ? "../outside.js" : fallback; } });
	const logs = [];
	vscode.window = { createOutputChannel: () => ({ appendLine: (value) => logs.push(value), dispose() {} }) };
	let called = false;
	const setup = createWorkspaceSetup(vscode, { spawn: () => { called = true; }, debounceMs: 1 });
	await wait(15);
	assert.equal(called, false);
	assert.ok(logs.some((line) => line.includes("relative path")));
	setup.dispose();
	await fs.rmdir(root);
});
