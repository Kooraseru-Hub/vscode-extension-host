"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

function parseDiagnostics(output, root, documents = []) {
	const dirty = new Set(documents.filter((document) => document.isDirty).map((document) => document.path));
	const openText = new Map(documents.map((document) => [document.path, document.text]));
	const findings = [];
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^(.*):(\d+):(\d+): (error|warning|information|hint): (?:\[([^\]]+)\] )?(.*)$/i);
		if (!match) continue;
		const absolute = path.resolve(match[1]);
		const relative = path.relative(root, absolute).split(path.sep).join("/");
		if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative) || dirty.has(relative)) continue;
		let text = openText.get(relative);
		if (text === undefined) {
			try { text = fs.readFileSync(absolute, "utf8"); } catch { text = ""; }
		}
		const sourceLine = text.split(/\r?\n/)[Number(match[2]) - 1] || "";
		const tokenLength = /Do not use any in Luau type annotations/.test(match[6]) ? 3 : undefined;
		findings.push({
			path: relative,
			line: Number(match[2]),
			column: Number(match[3]),
			endLine: Number(match[2]),
			endColumn: tokenLength ? Number(match[3]) + tokenLength : Math.max(Number(match[3]) + 1, sourceLine.length + 1),
			severity: match[4].toLowerCase(),
			source: match[5] || "Workspace check",
			message: match[6],
		});
	}
	return findings;
}

function createWorkspaceScriptProvider(vscode) {
	return {
		id: "vscode-extension-host.workspace-script",
		provideCodeActions({ document, context, workspaceRoot }) {
			const actions = [];
			const anyFindings = context.diagnostics.filter((diagnostic) => /^Rule: languages\/luau\/language\/types$/.test(diagnostic.source || "") && /Do not use any in Luau type annotations/.test(diagnostic.message));
			for (const diagnostic of anyFindings) {
				const action = new vscode.CodeAction("Replace any with unknown", vscode.CodeActionKind.QuickFix);
				action.diagnostics = [diagnostic];
				action.isPreferred = true;
				action.edit = new vscode.WorkspaceEdit();
				action.edit.replace(document.uri, diagnostic.range, "unknown");
				actions.push(action);
			}
			const pathHeaderFindings = context.diagnostics.filter((diagnostic) => /^Rule: languages\/luau\/files\/path-headers$/.test(diagnostic.source || "") && /expected path header|expected --!strict after the path header/.test(diagnostic.message));
			if (pathHeaderFindings.length) {
				const relative = path.relative(workspaceRoot, document.uri.fsPath).split(path.sep).join("/");
				const missingPath = pathHeaderFindings.some((diagnostic) => /expected path header/.test(diagnostic.message));
				const action = new vscode.CodeAction(missingPath ? "Add required path header" : "Add --!strict after the path header", vscode.CodeActionKind.QuickFix);
				action.diagnostics = pathHeaderFindings;
				action.isPreferred = true;
				action.edit = new vscode.WorkspaceEdit();
				if (missingPath) action.edit.insert(document.uri, new vscode.Position(0, 0), `-- ${relative}\n`);
				else action.edit.insert(document.uri, new vscode.Position(1, 0), "--!strict\n");
				actions.push(action);
			}
			return actions;
		},
		async provideDiagnostics(input) {
			const configuration = vscode.workspace.getConfiguration("vscodeExtensionHost", input.workspaceFolder.uri);
			const scriptName = configuration.get("diagnosticsScript", "");
			if (!scriptName) return { diagnostics: [] };
			const script = path.resolve(input.workspaceRoot, scriptName);
			const relative = path.relative(input.workspaceRoot, script);
			if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative)) {
				return { diagnostics: [{ path: ".vscode/settings.json", line: 1, column: 1, message: "vscodeExtensionHost.diagnosticsScript must stay inside the workspace.", severity: "error", source: "Extension Host" }] };
			}
			if (!fs.existsSync(script)) return { diagnostics: [] };
			const args = configuration.get("diagnosticsScriptArgs", []);
			const stdout = await new Promise((resolve, reject) => {
				const child = spawn(process.execPath, [script, ...(Array.isArray(args) ? args : [])], { cwd: input.workspaceRoot, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
				let output = "";
				let stderr = "";
				child.stdout.setEncoding("utf8").on("data", (chunk) => { output += chunk; });
				child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
				const abort = () => child.kill();
				input.signal?.addEventListener("abort", abort, { once: true });
				child.once("error", reject);
				child.once("close", (code) => {
					input.signal?.removeEventListener("abort", abort);
					if (input.signal?.aborted) return resolve("");
					if (code !== 0) return reject(new Error(stderr.trim() || `Diagnostics script exited with status ${code}.`));
					resolve(output);
				});
			});
			return { diagnostics: parseDiagnostics(stdout, input.workspaceRoot, input.documents) };
		},
	};
}

module.exports = { createWorkspaceScriptProvider, parseDiagnostics };
