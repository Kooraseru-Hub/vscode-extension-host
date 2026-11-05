"use strict";

const { createDiagnosticHost } = require("./diagnostic-host");
const { createWorkspaceScriptProvider } = require("./workspace-script-provider");
const { createWorkspaceCommandProvider } = require("./workspace-command-provider");
const { createWorkspaceSetup } = require("./workspace-setup");

function activateWith(vscode, context) {
	const host = createDiagnosticHost(vscode, context);
	host.api.registerDiagnosticProvider(createWorkspaceScriptProvider(vscode));
	host.api.registerDiagnosticProvider(createWorkspaceCommandProvider(vscode));
	context.subscriptions.push(createWorkspaceSetup(vscode));
	return host.api;
}

function activate(context) {
	return activateWith(require("vscode"), context);
}

module.exports = { activate, activateWith };
