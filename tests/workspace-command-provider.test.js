"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createWorkspaceCommandProvider } = require("../src/workspace-command-provider");

function providerFor(command, trusted = true) {
	const vscode = { workspace: {
		isTrusted: trusted,
		getConfiguration: () => ({ get: () => command }),
	} };
	return createWorkspaceCommandProvider(vscode);
}

function input(text) {
	return {
		workspaceFolder: { uri: {} },
		workspaceRoot: process.cwd(),
		reason: "document-change",
		documents: [{ path: "example.txt", text, languageId: "plaintext", version: 2, isDirty: true }],
		signal: new AbortController().signal,
	};
}

test("sends unsaved snapshots and replaces findings when source is corrected", async () => {
	const script = 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const x=JSON.parse(s);const d=x.documents[0];process.stdout.write(JSON.stringify({diagnostics:d.text==="bad"?[{path:d.path,line:1,column:1,message:"bad"}]:[]}));});';
	const provider = providerFor([process.execPath, "-e", script]);
	assert.equal((await provider.provideDiagnostics(input("bad"))).diagnostics[0].message, "bad");
	assert.deepEqual((await provider.provideDiagnostics(input("good"))).diagnostics, []);
});

test("does not execute commands in an untrusted workspace", async () => {
	const provider = providerFor(["a-command-that-must-not-run"], false);
	assert.deepEqual((await provider.provideDiagnostics(input("bad"))).diagnostics, []);
});

test("reports malformed command output as a failure", async () => {
	const provider = providerFor([process.execPath, "-e", 'process.stdout.write("not json")']);
	await assert.rejects(provider.provideDiagnostics(input("bad")), /invalid JSON/);
});

test("cancels a superseded command", async () => {
	const provider = providerFor([process.execPath, "-e", 'setTimeout(() => process.stdout.write("{}"), 5000)']);
	const request = input("bad");
	const controller = new AbortController();
	request.signal = controller.signal;
	const pending = provider.provideDiagnostics(request);
	controller.abort();
	assert.deepEqual((await pending).diagnostics, []);
});
