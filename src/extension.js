"use strict";

const { createDiagnosticHost } = require("./diagnostic-host");
const { createWorkspaceSetup } = require("./workspace-setup");

function activateWith(vscode, context) {
	const host = createDiagnosticHost(vscode, context);
	context.subscriptions.push(createWorkspaceSetup(vscode));
	return host.api;
}

function activate(context) {
	return activateWith(require("vscode"), context);
}

module.exports = { activate, activateWith };
