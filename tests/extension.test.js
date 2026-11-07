"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { activateWith } = require("../src/extension");
const { listSessions } = require("../src/discovery");

test("workspace lifecycle starts only after trust, passes private discovery to external commands, and cleans restart/disposal", async t => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-extension-"));
	const discoveryRoot = path.join(root, "discovery");
	t.after(() => fs.rmSync(root, { recursive: true, force: true }));
	let trust, changed, folders;
	let enabled = true;
	const registered = new Map();
	const children = [];
	const folder = { name: "fixture", uri: { fsPath: root, toString: () => root } };
	const event = assign => callback => { assign(callback); return { dispose() {} }; };
	const vscode = {
		workspace: { isTrusted: false, workspaceFolders: [folder],
			getConfiguration: () => ({ get: (key, fallback) => key === "enabled" ? enabled : key === "workspaceCommands" ? [["node", "client.cjs"]] : fallback }),
			onDidGrantWorkspaceTrust: event(value => { trust = value; }),
			onDidChangeConfiguration: event(value => { changed = value; }),
			onDidChangeWorkspaceFolders: event(value => { folders = value; }),
		},
		window: { createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }) },
		commands: { registerCommand: (name, callback) => { registered.set(name, callback); return { dispose() { registered.delete(name); } }; } },
	};
	const api = activateWith(vscode, { subscriptions: [] }, { discoveryRoot, spawn(executable, args, options) {
		const child = new EventEmitter();
		Object.assign(child, { executable, args, options, kill() { this.killed = true; } });
		children.push(child); return child;
	} });
	t.after(() => api.dispose());
	await api.ready;
	assert.equal(api.getSessions().length, 0);
	assert.equal(children.length, 0);
	vscode.workspace.isTrusted = true;
	await trust();
	assert.equal(api.getSessions().length, 1);
	assert.equal(children.length, 1);
	assert.equal(children[0].options.cwd, root);
	assert.ok(fs.existsSync(children[0].options.env.WORKBENCH_BRIDGE_SESSION));
	const first = api.getSessions()[0].sessionId;
	await registered.get("workbenchBridge.restart")();
	assert.equal(children[0].killed, true);
	assert.notEqual(api.getSessions()[0].sessionId, first);
	enabled = false;
	await changed({ affectsConfiguration: () => true });
	assert.equal(api.getSessions().length, 0);
	assert.equal(listSessions({ workspace: root, discoveryRoot }).length, 0);
	enabled = true;
	await folders();
	assert.equal(api.getSessions().length, 1);
	await api.dispose();
	assert.equal(registered.size, 0);
	assert.equal(children.at(-1).killed, true);
	assert.equal(listSessions({ workspace: root, discoveryRoot }).length, 0);
});
