"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createDiagnosticHost } = require("../src/diagnostic-host");
const { makeDocument, makeVscode } = require("./mock-vscode");

function temporaryRoots(count) {
	return Array.from({ length: count }, (_, index) => path.join(os.tmpdir(), "host-test-" + process.pid + "-" + index));
}

function wait(ms = 30) { return new Promise((resolve) => setTimeout(resolve, ms)); }

test("runs without a product plugin and publishes initial workspace diagnostics", async () => {
	const [root] = temporaryRoots(1);
	const vscode = makeVscode([root]);
	const host = createDiagnosticHost(vscode, undefined, { debounceMs: 1 });
	const registration = host.api.registerDiagnosticProvider({
		id: "sample",
		provideDiagnostics: async () => [{ path: "src/file.cpp", line: 2, column: 3, severity: "warning", message: "Sample finding" }],
	});
	await wait();
	assert.equal(vscode.collections[0].entries.size, 1);
	const diagnostics = [...vscode.collections[0].entries.values()][0];
	assert.equal(diagnostics[0].message, "Sample finding");
	assert.equal(diagnostics[0].range.start.line, 1);
	registration.dispose();
	assert.equal(vscode.collections[0].entries.size, 0);
	host.dispose();
});

test("passes dirty document snapshots and clears corrected diagnostics", async () => {
	const [root] = temporaryRoots(1);
	const vscode = makeVscode([root]);
	const document = makeDocument(root, "src/main.cpp", "invalid", { isDirty: true });
	vscode.workspace.textDocuments.push(document);
	const host = createDiagnosticHost(vscode, undefined, { debounceMs: 1 });
	let received = "";
	const registration = host.api.registerDiagnosticProvider({
		id: "buffer-check",
		provideDiagnostics: async ({ documents }) => {
			received = documents.find((item) => item.path === "src/main.cpp")?.text || "";
			return received === "invalid" ? [{ path: "src/main.cpp", message: "Invalid buffer" }] : [];
		},
	});
	await wait();
	assert.equal(received, "invalid");
	assert.equal(vscode.collections[0].entries.size, 1);
	document.setText("valid");
	vscode.events.change.fire({ document, contentChanges: [] });
	await wait();
	assert.equal(received, "valid");
	assert.equal(vscode.collections[0].entries.size, 0);
	registration.dispose();
	host.dispose();
});

test("isolates providers across workspaces and turns provider failures into diagnostics", async () => {
	const roots = temporaryRoots(2);
	const vscode = makeVscode(roots);
	const host = createDiagnosticHost(vscode, undefined, { debounceMs: 1 });
	host.api.registerDiagnosticProvider({ id: "workspace-check", provideDiagnostics: async ({ workspaceRoot }) => {
		if (workspaceRoot === roots[1]) throw new Error("checker crashed");
		return [{ path: "file.txt", message: "First workspace" }];
	} });
	await wait();
	assert.equal(vscode.collections[0].entries.size, 1);
	assert.equal(vscode.collections[1].entries.size, 1);
	const failure = [...vscode.collections[1].entries.values()][0][0];
	assert.equal(failure.code, "provider-failed");
	assert.match(failure.message, /checker crashed/);
	host.dispose();
});

test("discards stale asynchronous results and ignores paths outside workspace", async () => {
	const [root] = temporaryRoots(1);
	const vscode = makeVscode([root]);
	const document = makeDocument(root, "file.txt", "first");
	vscode.workspace.textDocuments.push(document);
	const host = createDiagnosticHost(vscode, undefined, { debounceMs: 1 });
	let releaseFirst;
	let calls = 0;
	host.api.registerDiagnosticProvider({ id: "race", provideDiagnostics: async ({ documents }) => {
		calls++;
		if (documents[0]?.text === "first") {
			await new Promise((resolve) => { releaseFirst = resolve; });
			return [{ path: "file.txt", message: "stale" }];
		}
		return [
			{ path: "file.txt", message: "current" },
			{ path: "../outside.txt", message: "must be discarded" },
		];
	} });
	await wait();
	document.setText("second");
	vscode.events.change.fire({ document, contentChanges: [] });
	await wait();
	releaseFirst();
	await wait();
	assert.equal(calls, 2);
	assert.equal(vscode.collections[0].entries.size, 1);
	const diagnostics = [...vscode.collections[0].entries.values()][0];
	assert.deepEqual(diagnostics.map((item) => item.message), ["current"]);
	host.dispose();
});
