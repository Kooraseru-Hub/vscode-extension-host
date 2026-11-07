"use strict";
const { spawn } = require("node:child_process");
const { startBridgeServer } = require("./bridge-server");

function activateWith(vscode, context, options = {}) {
	const records = new Map();
	const output = vscode.window?.createOutputChannel?.("Workbench Bridge");
	const subscriptions = [];
	let disposed = false;
	let generation = 0;
	let queue = Promise.resolve();
	const log = message => output?.appendLine(message);

	async function stop(record) {
		await record.server.dispose();
		// Give clients a chance to abort their own children after disconnect.
		await Promise.all(record.children.map(child => new Promise(resolve => {
			if (child.killed || child.exitCode !== null && child.exitCode !== undefined) return resolve();
			const stopped = () => { clearTimeout(timer); child.removeListener("close", stopped); resolve(); };
			const timer = setTimeout(() => { child.kill(); stopped(); }, 300);
			child.once("close", stopped);
		})));
	}
	async function configure() {
		const current = ++generation;
		for (const record of records.values()) await stop(record);
		records.clear();
		if (disposed || vscode.workspace.isTrusted !== true) return;
		for (const folder of vscode.workspace.workspaceFolders || []) {
			if (disposed || current !== generation) return;
			const config = vscode.workspace.getConfiguration("workbenchBridge", folder.uri);
			if (config.get("enabled", true) === false) continue;
			try {
				const server = await startBridgeServer({ vscode, extensionContext: context, workspaceFolder: folder, discoveryRoot: options.discoveryRoot,
					maxPayload: config.get("maxMessageBytes", 64 * 1024 * 1024), onError: error => log(`${folder.name}: ${error.message || error}`),
				});
				if (disposed || current !== generation) { await server.dispose(); continue; }
				const record = { server, children: [] };
				records.set(folder.uri.toString(), record);
				log(`${folder.name}: bridge ready`);
				const commands = config.get("workspaceCommands", []);
				if (!Array.isArray(commands) || commands.some(command => !Array.isArray(command) || !command.length || command.some(arg => typeof arg !== "string"))) throw new Error("workbenchBridge.workspaceCommands requires executable/argument arrays.");
				for (const command of commands) {
					const child = (options.spawn || spawn)(command[0], command.slice(1), { cwd: folder.uri.fsPath, windowsHide: true,
						env: { ...process.env, WORKBENCH_BRIDGE_SESSION: server.sessionFile }, stdio: ["ignore", "pipe", "pipe"],
					});
					record.children.push(child);
					child.stdout?.on("data", chunk => log(`[${folder.name}] ${chunk.toString().trimEnd()}`));
					child.stderr?.on("data", chunk => log(`[${folder.name}] ${chunk.toString().trimEnd()}`));
					child.on("error", error => log(`${folder.name}: workspace command failed: ${error.message}`));
					child.on("close", code => { if (code) log(`${folder.name}: workspace command exited with ${code}`); });
				}
			} catch (error) { log(`${folder.name}: ${error.message || error}`); vscode.window?.showErrorMessage?.(`Workbench Bridge: ${error.message || error}`); }
		}
	}
	const schedule = () => { queue = queue.then(configure).catch(error => log(error.message || String(error))); return queue; };
	if (vscode.workspace.onDidGrantWorkspaceTrust) subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(schedule));
	if (vscode.workspace.onDidChangeWorkspaceFolders) subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(schedule));
	if (vscode.workspace.onDidChangeConfiguration) subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if (event.affectsConfiguration("workbenchBridge") || vscode.workspace.isTrusted !== true) return schedule();
	}));
	if (vscode.commands?.registerCommand) {
		subscriptions.push(vscode.commands.registerCommand("workbenchBridge.showOutput", () => output?.show(true)));
		subscriptions.push(vscode.commands.registerCommand("workbenchBridge.restart", schedule));
	}
	const ready = schedule();
	async function dispose() {
		if (disposed) return;
		disposed = true; generation++;
		for (const subscription of subscriptions) subscription.dispose();
		await queue;
		for (const record of records.values()) await stop(record);
		records.clear(); output?.dispose();
	}
	context.subscriptions.push({ dispose });
	return Object.freeze({ ready, dispose, getSessions: () => [...records.values()].map(({ server }) => ({ sessionId: server.sessionId, workspace: server.workspace })) });
}
let active;
function activate(context) { active = activateWith(require("vscode"), context); return active; }
async function deactivate() { await active?.dispose(); active = undefined; }
module.exports = { activate, activateWith, deactivate };
