"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");

function isInside(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative !== "" && relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative);
}

function createWorkspaceSetup(vscode, options = {}) {
	const records = new Map();
	const subscriptions = [];
	const output = vscode.window?.createOutputChannel?.("Kooraseru Workspace Setup");
	const delay = options.debounceMs ?? 250;
	let disposed = false;

	function log(message) {
		if (output) output.appendLine(message);
		else console.error(message);
	}

	function stop(record) {
		record.disposed = true;
		clearTimeout(record.timer);
		for (const watcher of record.watchers) watcher.dispose();
		record.watchers.length = 0;
		record.child?.kill();
	}

	async function run(record) {
		if (disposed || record.disposed || vscode.workspace.isTrusted !== true) return;
		if (record.running) {
			record.pending = true;
			return;
		}
		record.running = true;
		try {
			const root = await fs.realpath(record.folder.uri.fsPath);
			const script = await fs.realpath(path.resolve(root, record.script));
			if (!isInside(root, script)) throw new Error("Workspace setup script must be inside the workspace.");
			if (!(await fs.stat(script)).isFile()) throw new Error("Workspace setup script must be a file.");
			if (disposed || record.disposed || vscode.workspace.isTrusted !== true) return;
			await new Promise((resolve, reject) => {
				const child = (options.spawn || spawn)(process.execPath, [script], {
					cwd: root,
					env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
					windowsHide: true,
					stdio: ["ignore", "pipe", "pipe"],
				});
				record.child = child;
				let stdout = "";
				let stderr = "";
				child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
				child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
				child.once("error", reject);
				child.once("close", (code, signal) => {
					if (record.child === child) record.child = undefined;
					if (record.disposed || disposed) return resolve();
					if (stdout.trim()) log(`[${record.folder.name}] ${stdout.trim()}`);
					if (stderr.trim()) log(`[${record.folder.name}] ${stderr.trim()}`);
					if (code !== 0) return reject(new Error(`Workspace setup exited with ${signal || code}.`));
					resolve();
				});
			});
		} catch (error) {
			if (!record.disposed && !disposed) log(`[${record.folder.name}] Workspace setup failed: ${error.message || String(error)}`);
		} finally {
			record.running = false;
			if (record.pending && !record.disposed && !disposed) {
				record.pending = false;
				void run(record);
			}
		}
	}

	function schedule(record) {
		if (record.disposed || disposed) return;
		clearTimeout(record.timer);
		record.timer = setTimeout(() => { record.timer = undefined; void run(record); }, delay);
	}

	function validRelative(value) {
		return typeof value === "string" && value.trim() !== "" && !path.isAbsolute(value)
			&& !value.split(/[\\/]/).includes("..");
	}

	function configure(folder) {
		const key = folder.uri.toString();
		if (records.has(key)) stop(records.get(key));
		records.delete(key);
		if (vscode.workspace.isTrusted !== true || (folder.uri.scheme && folder.uri.scheme !== "file")) return;
		const config = vscode.workspace.getConfiguration("vscodeExtensionHost", folder.uri);
		const script = config.get("workspaceSetupScript", "");
		if (!script) return;
		if (!validRelative(script)) {
			log(`[${folder.name}] Workspace setup script must be a relative path inside the workspace.`);
			return;
		}
		const watch = config.get("workspaceSetupWatch", []);
		if (!Array.isArray(watch) || watch.some((item) => !validRelative(item))) {
			log(`[${folder.name}] Workspace setup watch patterns must be relative to the workspace.`);
			return;
		}
		const record = { folder, script, watchers: [], running: false, pending: false, disposed: false };
		records.set(key, record);
		for (const pattern of new Set([script, ...watch])) {
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
			watcher.onDidCreate(() => schedule(record));
			watcher.onDidChange(() => schedule(record));
			watcher.onDidDelete(() => schedule(record));
			record.watchers.push(watcher);
		}
		schedule(record);
	}

	function configureAll() {
		for (const record of records.values()) stop(record);
		records.clear();
		for (const folder of vscode.workspace.workspaceFolders || []) configure(folder);
	}

	if (vscode.workspace.onDidGrantWorkspaceTrust) {
		subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(configureAll));
	}
	if (vscode.workspace.onDidChangeConfiguration) {
		subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("vscodeExtensionHost.workspaceSetupScript")
				|| event.affectsConfiguration("vscodeExtensionHost.workspaceSetupWatch")) configureAll();
		}));
	}
	if (vscode.workspace.onDidChangeWorkspaceFolders) {
		subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders((event) => {
			for (const folder of event.removed) {
				const key = folder.uri.toString();
				if (records.has(key)) stop(records.get(key));
				records.delete(key);
			}
			for (const folder of event.added) configure(folder);
		}));
	}
	configureAll();

	return {
		dispose() {
			disposed = true;
			for (const record of records.values()) stop(record);
			records.clear();
			for (const subscription of subscriptions) subscription.dispose();
			output?.dispose();
		},
	};
}

module.exports = { createWorkspaceSetup, isInside };
