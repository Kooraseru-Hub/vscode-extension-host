"use strict";

const { createDiagnosticHost } = require("./diagnostic-host");

function activateWith(vscode, context) {
	const host = createDiagnosticHost(vscode, context);
	return host.api;
}

function activate(context) {
	return activateWith(require("vscode"), context);
}

module.exports = { activate, activateWith };
