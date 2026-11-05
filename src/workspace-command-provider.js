"use strict";

const { spawn } = require("node:child_process");

function documentSnapshot(document) {
	if (!document) return undefined;
	return {
		path: document.path,
		text: document.text,
		languageId: document.languageId,
		version: document.version,
		isDirty: document.isDirty,
	};
}

function createWorkspaceCommandProvider(vscode) {
	return {
		id: "vscode-extension-host.workspace-command",
		async provideDiagnostics(input) {
			if (vscode.workspace.isTrusted === false) return { diagnostics: [] };
			const configuration = vscode.workspace.getConfiguration("vscodeExtensionHost", input.workspaceFolder.uri);
			const command = configuration.get("diagnosticsCommand", []);
			if (!Array.isArray(command) || command.length === 0) return { diagnostics: [] };
			if (command.some((part) => typeof part !== "string") || !command[0].trim()) {
				throw new TypeError("diagnosticsCommand must contain an executable and string arguments.");
			}
			const request = {
				workspaceRoot: input.workspaceRoot,
				reason: input.reason,
				documents: input.documents.map(documentSnapshot),
				changedDocument: documentSnapshot(input.changedDocument),
				changedFile: input.changedFile && { path: input.changedFile.path, kind: input.changedFile.kind },
			};
			const output = await new Promise((resolve, reject) => {
				if (input.signal?.aborted) return resolve("");
				const child = spawn(command[0], command.slice(1), {
					cwd: input.workspaceRoot,
					windowsHide: true,
					stdio: ["pipe", "pipe", "pipe"],
				});
				let stdout = "";
				let stderr = "";
				const abort = () => child.kill();
				input.signal?.addEventListener("abort", abort, { once: true });
				child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
				child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
				child.stdin.on("error", (error) => { if (error.code !== "EPIPE") reject(error); });
				child.once("error", reject);
				child.once("close", (code) => {
					input.signal?.removeEventListener("abort", abort);
					if (input.signal?.aborted) return resolve("");
					if (code !== 0) return reject(new Error(stderr.trim() || `Diagnostic command exited with status ${code}.`));
					resolve(stdout);
				});
				child.stdin.end(JSON.stringify(request));
			});
			if (input.signal?.aborted) return { diagnostics: [] };
			let result;
			try { result = JSON.parse(output); } catch { throw new Error("Diagnostic command returned invalid JSON."); }
			if (!result || !Array.isArray(result.diagnostics)) {
				throw new TypeError("Diagnostic command must return an object with a diagnostics array.");
			}
			return { diagnostics: result.diagnostics };
		},
	};
}

module.exports = { createWorkspaceCommandProvider };
