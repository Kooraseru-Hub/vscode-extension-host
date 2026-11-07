"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const WebSocket = require("ws");
const { startBridgeServer } = require("../src/bridge-server");
const { readDiscovery, writeDiscovery, sessionDirectory } = require("../src/discovery");

function tempDir(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }
function socketOpen(url, options) {
	const socket = new WebSocket(url, options);
	return new Promise((resolve, reject) => { socket.once("open", () => resolve(socket)); socket.once("error", reject); });
}
function rpc(socket, method, params, options = {}) {
	const id = Math.floor(Math.random() * 1e9);
	return new Promise((resolve, reject) => {
		const onMessage = (raw) => {
			let message; try { message = JSON.parse(raw.toString()); } catch (error) { cleanup(); reject(error); return; }
			if (message.id !== id) return;
			cleanup(); resolve(message);
		};
		const onError = (error) => { cleanup(); reject(error); };
		const cleanup = () => { socket.off("message", onMessage); socket.off("error", onError); };
		socket.on("message", onMessage); socket.on("error", onError);
		const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
		socket.send(options.binary ? Buffer.from(payload) : payload);
	});
}
async function fixture(t, options = {}) {
	const workspacePath = tempDir("bridge-server-workspace-");
	const discoveryRoot = tempDir("bridge-server-discovery-");
	t.after(() => { fs.rmSync(workspacePath, { recursive: true, force: true }); fs.rmSync(discoveryRoot, { recursive: true, force: true }); });
	const workspace = { isTrusted: options.trusted ?? true };
	const counts = { owned: 0, borrowed: 0, nativeError: null };
	const vscode = {
		workspace,
		makeOwned() { return { dispose() { counts.owned++; } }; },
		makeBorrowed() { return { dispose() { counts.borrowed++; } }; },
		fail() { throw counts.nativeError; },
	};
	const folder = { name: "server-test", uri: { fsPath: workspacePath } };
	const server = await startBridgeServer({ vscode, extensionContext: { subscriptions: [] }, workspaceFolder: folder, discoveryRoot });
	t.after(() => server.dispose());
	const descriptor = readDiscovery({ sessionFile: server.sessionFile });
	return { server, descriptor, workspace, counts, workspacePath, discoveryRoot };
}
async function authenticatedSocket(descriptor, token = descriptor.token, workspace = descriptor.workspace) {
	const socket = await socketOpen(descriptor.endpoint);
	const response = await rpc(socket, "connect", { token, workspace });
	return { socket, response };
}

test("server requires workspace trust before it starts and on every request", async (t) => {
	const workspacePath = tempDir("bridge-untrusted-"); t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }));
	await assert.rejects(startBridgeServer({ vscode: { workspace: { isTrusted: false } }, extensionContext: {}, workspaceFolder: { uri: { fsPath: workspacePath } } }), /trust/i);
	const f = await fixture(t);
	const { socket } = await authenticatedSocket(f.descriptor);
	f.workspace.isTrusted = false;
	const denied = await rpc(socket, "get", { target: "vscode", path: ["workspace"] });
	assert.equal(denied.error.code, -32002);
	socket.terminate();
});

test("authentication is required before any bridge operation and wrong tokens are rejected", async (t) => {
	const { descriptor } = await fixture(t);
	const unauth = await socketOpen(descriptor.endpoint);
	const beforeAuth = await rpc(unauth, "get", { target: "vscode", path: ["workspace"] });
	assert.equal(beforeAuth.error.code, -32001);
	await new Promise((resolve) => unauth.once("close", resolve));
	const wrong = await socketOpen(descriptor.endpoint);
	const auth = await rpc(wrong, "connect", { token: "incorrect", workspace: descriptor.workspace });
	assert.equal(auth.error.code, -32001);
	await new Promise((resolve) => wrong.once("close", resolve));
});

test("server rejects browser origins before authentication", async (t) => {
	const { descriptor } = await fixture(t);
	await assert.rejects(socketOpen(descriptor.endpoint, { headers: { Origin: "https://attacker.example" } }));
});

test("explicit session selection resolves multiple windows for one workspace", async (t) => {
	const first = await fixture(t); const second = await fixture(t);
	// Use one workspace identity for both independent server instances.
	await second.server.dispose();
	const secondServer = await startBridgeServer({ vscode: { workspace: { isTrusted: true } }, extensionContext: {}, workspaceFolder: { name: "same", uri: { fsPath: first.workspacePath } }, discoveryRoot: first.discoveryRoot });
	t.after(() => secondServer.dispose());
	const selected = readDiscovery({ workspace: first.workspacePath, discoveryRoot: first.discoveryRoot, sessionId: secondServer.sessionId });
	assert.equal(selected.sessionId, secondServer.sessionId);
	assert.throws(() => readDiscovery({ workspace: first.workspacePath, discoveryRoot: first.discoveryRoot }), /Multiple VS Code sessions/);
	const { socket, response } = await authenticatedSocket(selected);
	assert.equal(response.result.sessionId, secondServer.sessionId); socket.close();
});

test("malformed JSON, binary JSON frames, and native errors preserve protocol behavior", async (t) => {
	const f = await fixture(t); f.counts.nativeError = Object.assign(new TypeError("native provider failure"), { code: -31999 });
	const { socket } = await authenticatedSocket(f.descriptor);
	const malformed = await new Promise((resolve) => {
		const onMessage = (raw) => { const message = JSON.parse(raw.toString()); if (message.id === null) { socket.off("message", onMessage); resolve(message); } };
		socket.on("message", onMessage); socket.send("{");
	});
	assert.equal(malformed.error.code, -32700);
	const binary = await rpc(socket, "get", { target: "vscode", path: ["workspace", "isTrusted"] }, { binary: true });
	assert.equal(binary.result, true);
	const native = await rpc(socket, "call", { target: "vscode", path: ["fail"], args: [] });
	assert.equal(native.error.code, -31999); assert.equal(native.error.message, "native provider failure");
	socket.close();
});

test("disconnect disposes explicitly owned handles and leaves borrowed handles alone", async (t) => {
	const { descriptor, counts } = await fixture(t);
	const { socket } = await authenticatedSocket(descriptor);
	const owned = await rpc(socket, "call", { target: "vscode", path: ["makeOwned"], args: [], owned: true });
	const borrowed = await rpc(socket, "call", { target: "vscode", path: ["makeBorrowed"], args: [] });
	assert.equal(owned.result.$type, "ref"); assert.equal(borrowed.result.$type, "ref");
	socket.terminate();
	const deadline = Date.now() + 1000;
	while (Date.now() < deadline && counts.owned === 0) await new Promise((resolve) => setTimeout(resolve, 10));
	assert.equal(counts.owned, 1); assert.equal(counts.borrowed, 0);
});

test("private discovery directory and record are owner-only, and directory symlinks are rejected", (t) => {
	const workspace = tempDir("bridge-private-workspace-"); const root = tempDir("bridge-private-root-");
	t.after(() => { fs.rmSync(workspace, { recursive: true, force: true }); fs.rmSync(root, { recursive: true, force: true }); });
	const record = { sessionId: "private-test", endpoint: "ws://127.0.0.1:1234/bridge/private-test", token: "must-not-be-printed", workspace, pid: process.pid };
	const written = writeDiscovery(record, root);
	const directory = sessionDirectory({ workspace, discoveryRoot: root });
	if (process.platform !== "win32") {
		assert.equal(fs.statSync(directory).mode & 0o777, 0o700);
		assert.equal(fs.statSync(written.file).mode & 0o777, 0o600);
	} else {
		const dirAcl = spawnSync("icacls.exe", [directory], { encoding: "utf8", windowsHide: true });
		const fileAcl = spawnSync("icacls.exe", [written.file], { encoding: "utf8", windowsHide: true });
		assert.equal(dirAcl.status, 0); assert.equal(fileAcl.status, 0);
		assert.doesNotMatch(dirAcl.stdout, /\(I\)/); assert.doesNotMatch(fileAcl.stdout, /\(I\)/);
		assert.equal(dirAcl.stdout.split(/\r?\n/).filter((line) => line.includes(":(")).length, 1);
		assert.equal(fileAcl.stdout.split(/\r?\n/).filter((line) => line.includes(":(")).length, 1);
	}
	written.dispose();
	const external = tempDir("bridge-private-external-");
	t.after(() => fs.rmSync(external, { recursive: true, force: true }));
	const linkRoot = path.join(external, "link-root");
	fs.symlinkSync(root, linkRoot, process.platform === "win32" ? "junction" : "dir");
	assert.throws(() => writeDiscovery({ ...record, sessionId: "linked" }, linkRoot), /symbolic links/);
});
