"use strict";

const vscode = require("vscode");
const { createDiagnosticHost } = require("./diagnostic-host");

function activate(context) {
	const host = createDiagnosticHost(vscode, context);
	return host.api;
}

module.exports = { activate };
