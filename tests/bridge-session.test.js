"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createBridgeSession } = require("../src/bridge-session");

function fixture(extra = {}) {
	const context = { subscriptions: [] };
	const root = { nested: { value: 2 }, plus(n) { return this.nested.value + n; }, make() { return { dispose() { this.disposed = true; }, disposed: false }; } };
	const vscode = { root };
	const calls = [];
	const session = createBridgeSession({ vscode, extensionContext: context, workspaceFolder: { uri: { fsPath: process.cwd() } }, invokeCallback: async (...args) => { calls.push(args); return "ok"; }, ...extra });
	return { session, context, vscode, calls };
}
const req = (session, method, params = {}, requestId) => session.dispatch(method, params, requestId);

test("get, set, call and construct preserve references and receiver", async () => {
	const { session, vscode } = fixture();
	assert.equal(await req(session, "get", { target: "vscode", path: ["root", "nested", "value"] }), 2);
	await req(session, "set", { target: "vscode", path: ["root", "nested", "value"], value: 8 });
	assert.equal(await req(session, "call", { target: "vscode", path: ["root", "plus"], args: [3] }), 11);
	const ctor = class { constructor(v) { this.v = v; } };
	vscode.Ctor = ctor;
	const ref = await req(session, "construct", { target: "vscode", path: ["Ctor"], args: ["x"] });
	assert.equal(ref.$type, "ref");
	assert.equal(await req(session, "get", { target: ref, path: ["v"] }), "x");
	await session.dispose();
});

test("repeated native objects keep one stable identity and callback arguments can contain refs", async () => {
	const { session, vscode, calls } = fixture();
	const native = new (class NativeThing { constructor() { this.label = "native"; } })();
	vscode.native = native;
	const first = await req(session, "get", { target: "vscode", path: ["native"] });
	const second = await req(session, "get", { target: "vscode", path: ["native"] });
	assert.deepEqual(first, second);
	vscode.accept = (callback) => { setImmediate(() => callback(native, undefined, 7n, NaN)); return "accepted"; };
	assert.equal(await req(session, "call", { target: "vscode", path: ["accept"], args: [{ $type: "callback", id: "nested" }] }), "accepted");
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls[0][0], "nested");
	assert.deepEqual(calls[0][1], [first, { $type: "undefined" }, { $type: "bigint", value: "7" }, { $type: "number", value: "NaN" }]);
	await session.dispose();
});

test("native APIs receive decoded callback results, including async plain records", async () => {
	let seen;
	const { session, vscode } = fixture({ invokeCallback: async () => ({ $type: "object", entries: [["ok", true], ["items", { $type: "array", items: [1, { $type: "undefined" }] }]] }) });
	vscode.useCallback = async (callback) => { seen = await callback(); return seen; };
	const result = await req(session, "call", { target: "vscode", path: ["useCallback"], args: [{ $type: "callback", id: "getValue" }] });
	assert.equal(result.$type, "ref");
	assert.deepEqual(seen, { ok: true, items: [1, undefined] });
	await session.dispose();
});

test("callback signal follows request cancellation and connection close", async () => {
	let callbackSignal;
	const { session, vscode } = fixture({ invokeCallback: (_id, _args, signal) => {
		callbackSignal = signal;
		return new Promise((resolve) => signal.addEventListener("abort", () => resolve({ $type: "undefined" }), { once: true }));
	} });
	vscode.awaitCallback = (callback) => callback();
	const pending = req(session, "call", { target: "vscode", path: ["awaitCallback"], args: [{ $type: "callback", id: "slow" }] }, "callback-request");
	while (!callbackSignal) await new Promise((resolve) => setImmediate(resolve));
	session.cancel("callback-request");
	await assert.rejects(pending, /cancelled/); assert.equal(callbackSignal.aborted, true);
	await session.dispose();
});

test("wire decoding/encoding, snapshots, cycles, bigint and bytes", async () => {
	const { session, vscode } = fixture();
	const wire = { $type: "object", entries: [["a", { $type: "bigint", value: "9007199254740993" }], ["b", { $type: "array", items: [{ $type: "bytes", data: Buffer.from([1, 2]).toString("base64") }, { $type: "undefined" }] }] ] };
	await req(session, "set", { target: "vscode", path: ["value"], value: wire });
	assert.equal(vscode.value.a, 9007199254740993n);
	assert.deepEqual(vscode.value.b[0], Buffer.from([1, 2]));
	vscode.wireValues = () => [undefined, 12n, Buffer.from([0, 255]), NaN, Infinity, -Infinity];
	const values = await req(session, "call", { target: "vscode", path: ["wireValues"] });
	assert.equal(values.$type, "ref"); // returned arrays and records retain native identity
	const returned = await req(session, "snapshot", { target: values, path: [] });
	assert.deepEqual(returned.items, [
		{ $type: "undefined" }, { $type: "bigint", value: "12" },
		{ $type: "bytes", data: "AP8=" }, { $type: "number", value: "NaN" },
		{ $type: "number", value: "+Infinity" }, { $type: "number", value: "-Infinity" },
	]);
	const snap = await req(session, "snapshot", { target: "vscode", path: ["value"] });
	assert.equal(snap.$type, "object");
	const cycle = {}; cycle.self = cycle; vscode.cycle = cycle;
	await assert.rejects(req(session, "snapshot", { target: "vscode", path: ["cycle"] }), /cyclic/);
	vscode.special = [NaN, Infinity, -Infinity];
	const special = await req(session, "snapshot", { target: "vscode", path: ["special"] });
	assert.deepEqual(special.items.map((item) => item.value), ["NaN", "+Infinity", "-Infinity"]);
	await session.dispose();
});

test("callbacks, events, unsubscribe and owned versus borrowed resources", async () => {
	let listener; let disposeCount = 0;
	const eventHost = { on(callback) { listener = callback; return { dispose() { disposeCount++; } }; }, borrowed() { return { dispose() { disposeCount++; } }; } };
	const { session, vscode, calls } = fixture(); vscode.eventHost = eventHost;
	const sub = await req(session, "subscribe", { target: "vscode", path: ["eventHost", "on"], callback: { $type: "callback", id: "cb" } });
	listener({ value: 4 }); await new Promise((resolve) => setImmediate(resolve));
	assert.equal(calls[0][0], "cb");
	assert.equal(calls[0][1][0].$type, "ref");
	await req(session, "unsubscribe", { subscription: sub }); assert.equal(disposeCount, 1);
	const borrowed = await req(session, "call", { target: "vscode", path: ["eventHost", "borrowed"] });
	assert.equal(borrowed.$type, "ref");
	const owned = await req(session, "call", { target: "vscode", path: ["eventHost", "borrowed"], owned: true });
	assert.equal(owned.$type, "ref"); await session.dispose(); assert.equal(disposeCount, 2);
});

test("borrowed handles never dispose at close and native exceptions propagate unchanged", async () => {
	const failure = new RangeError("native provider failed"); let disposedCount = 0;
	const borrowed = { dispose() { disposedCount++; } };
	const { session, vscode } = fixture(); vscode.borrowed = borrowed; vscode.fail = async () => { await Promise.resolve(); throw failure; };
	const ref = await req(session, "get", { target: "vscode", path: ["borrowed"] });
	await assert.rejects(req(session, "call", { target: "vscode", path: ["fail"] }), (error) => error === failure && !error.code);
	await session.dispose(); assert.equal(disposedCount, 0);
	assert.equal(ref.$type, "ref");
});

test("protocol dispose targets only its reference and may dispose a borrowed handle", async () => {
	let disposed = 0;
	const { session, vscode } = fixture();
	vscode.one = { dispose() { disposed++; } }; vscode.two = { value: 42 };
	const one = await req(session, "get", { target: "vscode", path: ["one"] });
	const two = await req(session, "get", { target: "vscode", path: ["two"] });
	await req(session, "dispose", { target: one }); assert.equal(disposed, 1);
	assert.equal(await req(session, "get", { target: two, path: ["value"] }), 42);
	await session.dispose(); assert.equal(disposed, 1);
	await assert.rejects(req(session, "dispose", { target: two }), /disposed/);
});

test("set rejects an empty path and object decoding safely preserves __proto__ data", async () => {
	const { session, vscode } = fixture();
	const hostile = { $type: "object", entries: [["__proto__", { $type: "object", entries: [["polluted", true]] }]] };
	await req(session, "set", { target: "vscode", path: ["safe"], value: hostile });
	assert.equal(Object.getPrototypeOf(vscode.safe), Object.prototype);
	assert.equal(Object.hasOwn(vscode.safe, "__proto__"), true);
	assert.equal({}.polluted, undefined);
	await assert.rejects(req(session, "set", { target: "vscode", path: [], value: 1 }), /non-empty/);
	await session.dispose();
});

test("cancellation rejects promptly, preserves RPC error codes, and unknown methods use method-not-found", async () => {
	const { session, vscode } = fixture();
	vscode.never = () => new Promise(() => {});
	const pending = req(session, "call", { target: "vscode", path: ["never"] }, "prompt");
	assert.equal(session.cancel("prompt"), true);
	await assert.rejects(pending, (error) => error.code === -32800);
	await assert.rejects(req(session, "absent"), (error) => error.code === -32601);
	await assert.rejects(req(session, "get", { target: "bad" }), (error) => error.code === -32602);
	await session.dispose();
});

test("release leaves owned resource tracked; cancellation disposes late owned result", async () => {
	let disposals = 0; let lateDisposed;
	const disposed = new Promise((resolve) => { lateDisposed = resolve; });
	const { session, vscode } = fixture();
	vscode.wait = () => new Promise((resolve) => setTimeout(() => resolve({ dispose() { disposals++; lateDisposed(); } }), 20));
	const pending = req(session, "call", { target: "vscode", path: ["wait"], owned: true }, "req");
	assert.equal(session.cancel("req"), true);
	await assert.rejects(pending, /cancelled/); await disposed; assert.equal(disposals, 1);
	vscode.owned = { dispose() { disposals++; } };
	const ref = await req(session, "get", { target: "vscode", path: ["owned"] });
	await req(session, "release", { target: ref }); await session.dispose(); assert.equal(disposals, 1);
});

test("disconnect cleans an owned result that arrives after close", async () => {
	let resolve; let disposals = 0;
	const { session, vscode } = fixture();
	vscode.waitForOwned = () => new Promise((done) => { resolve = done; });
	const pending = req(session, "call", { target: "vscode", path: ["waitForOwned"], owned: true }, "late");
	while (!resolve) await new Promise((done) => setImmediate(done));
	await session.dispose(); resolve({ dispose() { disposals++; } });
	await assert.rejects(pending, /cancelled/); assert.equal(disposals, 1);
});

test("loadModule confines real paths, exposes context, and cleans activated modules", async (t) => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-session-"));
	t.after(() => fs.rm(dir, { recursive: true, force: true }));
	const file = path.join(dir, "module.mjs");
	await fs.writeFile(file, `export async function activate(ctx) { if (!ctx.vscode || !ctx.extensionContext || !ctx.workspaceFolder || !ctx.signal || !ctx.subscriptions || !ctx.asAbsolutePath) throw Error('context'); if (!ctx.asAbsolutePath('sub/file').includes('sub') || !ctx.asAbsolutePath('sub/file').includes('file')) throw Error('absolute path'); let rejected = false; try { ctx.asAbsolutePath('../outside'); } catch { rejected = true; } if (!rejected) throw Error('path escape'); globalThis.__bridgeActivated = true; ctx.subscriptions.push({ dispose() { globalThis.__bridgeCleaned = true; } }); return { ping() { return 'pong'; } }; } export function deactivate() { globalThis.__bridgeDeactivated = true; }`);
	const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-outside-"));
	await fs.writeFile(path.join(outsideDir, "escape.mjs"), "export function activate() {} ");
	const symlink = path.join(dir, "escape-dir");
	let hasSymlink = true;
	try { await fs.symlink(outsideDir, symlink, process.platform === "win32" ? "junction" : "dir"); } catch (error) { if (error.code === "EPERM" || error.code === "EACCES") hasSymlink = false; else throw error; }
	t.after(() => fs.rm(outsideDir, { recursive: true, force: true }));
	const { session } = fixture({ workspaceFolder: { uri: { fsPath: dir } } });
	const ref = await req(session, "loadModule", { path: "module.mjs" });
	assert.equal(await req(session, "call", { target: ref, path: ["ping"] }), "pong");
	if (hasSymlink) await assert.rejects(req(session, "loadModule", { path: path.join("escape-dir", "escape.mjs") }), /within workspace/);
	await session.dispose();
	assert.equal(globalThis.__bridgeCleaned, true); assert.equal(globalThis.__bridgeDeactivated, true);
	delete globalThis.__bridgeActivated; delete globalThis.__bridgeCleaned; delete globalThis.__bridgeDeactivated;
});

test("loadModule supports injected loader and cleans activation that resolves after cancellation", async () => {
	let resolveActivation; let cleaned = 0;
	const { session } = fixture({ moduleLoader: async () => ({ activate(ctx) { ctx.subscriptions.push({ dispose() { cleaned++; } }); return new Promise((resolve) => { resolveActivation = resolve; }); }, deactivate() { cleaned++; } }) });
	// Loader paths are still realpathed, so use a real file within the workspace.
	const file = path.join(process.cwd(), `bridge-loader-${Date.now()}.mjs`); await fs.writeFile(file, "// test");
	try {
		const pending = req(session, "loadModule", { path: path.basename(file) }, "load");
		while (!resolveActivation) await new Promise((resolve) => setImmediate(resolve));
		session.cancel("load"); resolveActivation({});
		await assert.rejects(pending, /cancelled/); assert.equal(cleaned, 2);
	} finally { await fs.rm(file, { force: true }); await session.dispose(); }
});

test("disposing shared callable module references cleans each activation exactly once", async () => {
	let deactivated = 0; let subDisposed = 0; let resultDisposed = 0; const moduleSignals = [];
	const file = path.join(process.cwd(), `bridge-dispose-module-${Date.now()}.mjs`); await fs.writeFile(file, "// test");
	const sharedCallable = () => "callable export";
	sharedCallable.dispose = () => { resultDisposed++; };
	const { session } = fixture({ moduleLoader: async () => ({ activate(ctx) { moduleSignals.push(ctx.signal); ctx.subscriptions.push({ dispose() { subDisposed++; } }); return sharedCallable; }, deactivate() { deactivated++; } }) });
	try {
		const moduleRef = await req(session, "loadModule", { path: path.basename(file) });
		const secondRef = await req(session, "loadModule", { path: path.basename(file) });
		assert.deepEqual(secondRef, moduleRef);
		assert.equal(await req(session, "call", { target: moduleRef, path: [] }), "callable export");
		await req(session, "dispose", { target: moduleRef });
		assert.equal(moduleSignals.every((signal) => signal.aborted), true); assert.equal(subDisposed, 2); assert.equal(deactivated, 2); assert.equal(resultDisposed, 2);
		await assert.rejects(req(session, "call", { target: moduleRef, path: [] }), /Unknown reference/);
		await session.dispose(); assert.equal(deactivated, 2);
	} finally { await fs.rm(file, { force: true }); await session.dispose(); }
});

test("activation cancellation aborts context immediately before activation finishes", async () => {
	let resolveActivation; let activationSignal; let subDisposed = 0;
	const file = path.join(process.cwd(), `bridge-immediate-cancel-${Date.now()}.mjs`); await fs.writeFile(file, "// test");
	const { session } = fixture({ moduleLoader: async () => ({ activate(ctx) { activationSignal = ctx.signal; ctx.subscriptions.push({ dispose() { subDisposed++; } }); return new Promise((resolve) => { resolveActivation = resolve; }); }, deactivate() {} }) });
	try {
		const pending = req(session, "loadModule", { path: path.basename(file) }, "activating");
		while (!resolveActivation) await new Promise((resolve) => setImmediate(resolve));
		session.cancel("activating");
		await assert.rejects(pending, /cancelled/);
		assert.equal(activationSignal.aborted, true); assert.equal(subDisposed, 1);
		resolveActivation({}); await new Promise((resolve) => setImmediate(resolve));
		assert.equal(subDisposed, 1);
	} finally { resolveActivation?.({}); await fs.rm(file, { force: true }); await session.dispose(); }
});

test("disconnect cleans subscriptions from module activation that resolves late", async () => {
	let resolveActivation; let disposals = 0;
	const file = path.join(process.cwd(), `bridge-late-module-${Date.now()}.mjs`); await fs.writeFile(file, "// test");
	const { session } = fixture({ moduleLoader: async () => ({ activate(ctx) { return new Promise((resolve) => { resolveActivation = () => { ctx.subscriptions.push({ dispose() { disposals++; } }); resolve({ dispose() { disposals++; } }); }; }); }, deactivate() { disposals++; } }) });
	try {
		const pending = req(session, "loadModule", { path: path.basename(file) }, "module");
		while (!resolveActivation) await new Promise((resolve) => setImmediate(resolve));
		await session.dispose(); resolveActivation();
		await assert.rejects(pending, /cancelled/); assert.equal(disposals, 3);
	} finally { await fs.rm(file, { force: true }); await session.dispose(); }
});
