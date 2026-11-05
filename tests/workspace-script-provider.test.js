"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { createWorkspaceScriptProvider, parseDiagnostics } = require("../src/workspace-script-provider");

test("parses rule sources and spans the reported token or complete line", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-script-"));
	try {
		const file = path.join(root, "source.luau");
		fs.writeFileSync(file, "local value: any = nil\nreturn false\n");
		const findings = parseDiagnostics([
			`${file}:1:14: error: [Rule: languages/luau/language/types] Do not use any in Luau type annotations; use unknown.`,
			`${file}:2:1: warning: [StyLua] Format differs`,
		].join("\n"), root);
		assert.equal(findings[0].source, "Rule: languages/luau/language/types");
		assert.equal(findings[0].endColumn, 17);
		assert.equal(findings[1].endColumn, "return false".length + 1);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("runs configured workspace diagnostics silently and respects dirty documents", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "host-script-"));
	try {
		const target = path.join(root, "invalid.lua");
		const script = path.join(root, "check.js");
		fs.writeFileSync(target, "return false\n");
		fs.writeFileSync(script, `console.log(${JSON.stringify(`${target}:1:1: error: [Rule: example] invalid`)});`);
		const vscode = { workspace: { getConfiguration: () => ({ get: (key, fallback) => ({ diagnosticsScript: "check.js", diagnosticsScriptArgs: [] })[key] ?? fallback }) } };
		const provider = createWorkspaceScriptProvider(vscode);
		const input = { workspaceFolder: { uri: { fsPath: root } }, workspaceRoot: root, documents: [], signal: new AbortController().signal };
		assert.equal((await provider.provideDiagnostics(input)).diagnostics[0].message, "invalid");
		input.documents = [{ path: "invalid.lua", text: "return true", isDirty: true }];
		assert.deepEqual((await provider.provideDiagnostics(input)).diagnostics, []);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});

test("offers explicit Quick Fixes for the Luau type and path-header rules", () => {
	const root = path.join(os.tmpdir(), "host-action-workspace");
	const vscode = {
		CodeActionKind: { QuickFix: "quickfix" },
		CodeAction: class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } },
		Position: class Position { constructor(line, character) { this.line = line; this.character = character; } },
		WorkspaceEdit: class WorkspaceEdit {
			replacements = [];
			insertions = [];
			replace(uri, range, text) { this.replacements.push({ uri, range, text }); }
			insert(uri, position, text) { this.insertions.push({ uri, position, text }); }
		},
	};
	const provider = createWorkspaceScriptProvider(vscode);
	const uri = { fsPath: path.join(root, "rules", "languages", "luau", "files", "path-headers", "invalid.luau") };
	const typeIssue = { source: "Rule: languages/luau/language/types", message: "Do not use any in Luau type annotations", range: { start: {}, end: {} } };
	const pathIssue = { source: "Rule: languages/luau/files/path-headers", message: "expected path header", range: { start: {}, end: {} } };
	const actions = provider.provideCodeActions({ document: { uri }, context: { diagnostics: [typeIssue, pathIssue] }, workspaceRoot: root });
	assert.deepEqual(actions.map((action) => action.title), ["Replace any with unknown", "Add required path header"]);
	assert.equal(actions[0].edit.replacements[0].text, "unknown");
	assert.match(actions[1].edit.insertions[0].text, /^-- rules\/languages\/luau\/files\/path-headers\/invalid\.luau\n$/);
});
