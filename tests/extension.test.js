"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { makeVscode } = require("./mock-vscode");
const { activateWith } = require("../src/extension");

test("activates the generic host without loading a product plugin", () => {
	const vscode = makeVscode([]);
	const context = { subscriptions: [] };
	const api = activateWith(vscode, context);
	assert.equal(api.apiVersion, 1);
	assert.deepEqual(api.getWorkspaceFolders(), []);
	assert.equal(typeof api.registerDiagnosticProvider, "function");
	assert.equal(context.subscriptions.length, 1);
	context.subscriptions[0].dispose();
});
