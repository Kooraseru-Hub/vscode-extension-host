"use strict";

const path = require("node:path");

function sameRoot(left, right) {
	const a = path.resolve(left);
	const b = path.resolve(right);
	return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function withinRoot(root, candidate) {
	const relative = path.relative(root, candidate);
	return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
}

function createDiagnosticHost(vscode, context, options = {}) {
	const debounceMs = options.debounceMs ?? 250;
	const providers = new Map();
	const workspaceListeners = new Set();
	const timers = new Set();
	const subscriptions = [];
	const watchers = new Map();

	function folders() {
		return vscode.workspace.workspaceFolders || [];
	}

	function snapshot(folder, reason, changedDocument) {
		const root = folder.uri.fsPath;
		return {
			workspaceFolder: folder,
			workspaceRoot: root,
			reason,
			changedDocument: changedDocument ? snapshotDocument(changedDocument, root) : undefined,
			documents: vscode.workspace.textDocuments
				.filter((document) => {
					const documentFolder = vscode.workspace.getWorkspaceFolder(document.uri);
					return documentFolder && sameRoot(documentFolder.uri.fsPath, root);
				})
				.map((document) => snapshotDocument(document, root)),
		};
	}

	function snapshotDocument(document, root) {
		const absolutePath = document.uri.scheme === "file" ? document.uri.fsPath : undefined;
		return Object.freeze({
			uri: document.uri,
			path: absolutePath && withinRoot(root, absolutePath)
				? path.relative(root, absolutePath).split(path.sep).join("/")
				: document.uri.toString(),
			text: document.getText(),
			languageId: document.languageId,
			version: document.version,
			isDirty: document.isDirty,
		});
	}

	function toDiagnostic(folder, providerId, finding) {
		if (!finding || typeof finding.message !== "string") {
			throw new TypeError("Diagnostic providers must return items with a message.");
		}
		const root = folder.uri.fsPath;
		let target;
		if (finding.path && path.isAbsolute(finding.path)) target = path.resolve(finding.path);
		else target = path.resolve(root, finding.path || ".");
		if (!withinRoot(root, target)) return undefined;
		const uri = vscode.Uri.file(target);
		const line = Number.isInteger(finding.line) && finding.line > 0 ? finding.line - 1 : 0;
		const column = Number.isInteger(finding.column) && finding.column > 0 ? finding.column - 1 : 0;
		const start = new vscode.Position(line, column);
		const severity = {
			error: vscode.DiagnosticSeverity.Error,
			warning: vscode.DiagnosticSeverity.Warning,
			information: vscode.DiagnosticSeverity.Information,
			hint: vscode.DiagnosticSeverity.Hint,
		}[finding.severity] ?? vscode.DiagnosticSeverity.Error;
		const diagnostic = new vscode.Diagnostic(new vscode.Range(start, start.translate(0, 1)), finding.message, severity);
		diagnostic.code = finding.code == null ? undefined : String(finding.code);
		diagnostic.source = String(finding.source || providerId);
		return { uri, diagnostic };
	}

	function clearState(state) {
		clearTimeout(state.timer);
		timers.delete(state.timer);
		state.timer = undefined;
		state.generation++;
		state.controller?.abort();
		state.controller = undefined;
		state.collection.clear();
	}

	function publish(state, findings) {
		const grouped = new Map();
		for (const finding of findings) {
			const converted = toDiagnostic(state.folder, state.providerId, finding);
			if (!converted) continue;
			const key = converted.uri.toString();
			const entry = grouped.get(key) || { uri: converted.uri, diagnostics: [] };
			entry.diagnostics.push(converted.diagnostic);
			grouped.set(key, entry);
		}
		state.collection.clear();
		for (const entry of grouped.values()) state.collection.set(entry.uri, entry.diagnostics);
	}

	async function run(state, reason, changedDocument, callerOptions) {
		if (state.disposed) return undefined;
		const generation = ++state.generation;
		state.controller?.abort();
		const controller = new AbortController();
		state.controller = controller;
		try {
			const result = await state.provider.provideDiagnostics({
				...snapshot(state.folder, reason, changedDocument),
				signal: controller.signal,
				options: callerOptions || {},
			});
			if (state.disposed || generation !== state.generation || controller.signal.aborted) return undefined;
			const findings = Array.isArray(result) ? result : result?.diagnostics;
			if (!Array.isArray(findings)) throw new TypeError("Diagnostic providers must return an array or { diagnostics }.");
			publish(state, findings);
			return result;
		} catch (error) {
			if (state.disposed || generation !== state.generation || controller.signal.aborted) return undefined;
			publish(state, [{
				path: ".",
				line: 1,
				column: 1,
				severity: "error",
				code: "provider-failed",
				source: state.providerId,
				message: error?.message || String(error),
			}]);
			return { status: "failed", diagnostics: [{ message: error?.message || String(error) }] };
		}
	}

	function stateFor(providerRecord, folder) {
		const root = path.resolve(folder.uri.fsPath);
		let state = providerRecord.workspaces.get(root);
		if (!state) {
			state = {
				providerId: providerRecord.provider.id,
				provider: providerRecord.provider,
				folder,
				collection: vscode.languages.createDiagnosticCollection(providerRecord.provider.id),
				timer: undefined,
				generation: 0,
				controller: undefined,
				disposed: false,
			};
			providerRecord.workspaces.set(root, state);
		}
		return state;
	}

	function schedule(state, reason, changedDocument) {
		clearTimeout(state.timer);
		timers.delete(state.timer);
		state.controller?.abort();
		const generation = ++state.generation;
		const timer = setTimeout(() => {
			timers.delete(timer);
			state.timer = undefined;
			if (state.disposed || generation !== state.generation) return;
			void run(state, reason, changedDocument);
		}, debounceMs);
		state.timer = timer;
		timers.add(timer);
	}

	function scheduleAll(reason, changedDocument, folder) {
		let target = folder;
		if (!target && changedDocument) target = vscode.workspace.getWorkspaceFolder(changedDocument.uri);
		for (const record of providers.values()) {
			for (const candidate of target ? [target] : folders()) {
				const state = stateFor(record, candidate);
				if (record.provider.matchesDocument && changedDocument && !record.provider.matchesDocument(changedDocument)) continue;
				schedule(state, reason, changedDocument);
			}
		}
	}

	function attachFolderWatchers(folder) {
		if (typeof vscode.workspace.createFileSystemWatcher !== "function") return;
		const root = path.resolve(folder.uri.fsPath);
		if (watchers.has(root)) return;
		const pattern = new vscode.RelativePattern(folder, "**/*");
		const watcher = vscode.workspace.createFileSystemWatcher(pattern);
		const trigger = () => scheduleAll("workspace-file-change", undefined, folder);
		watcher.onDidCreate(trigger, undefined, subscriptions);
		watcher.onDidChange(trigger, undefined, subscriptions);
		watcher.onDidDelete(trigger, undefined, subscriptions);
		subscriptions.push(watcher);
		watchers.set(root, watcher);
	}

	function registerDiagnosticProvider(provider) {
		if (!provider || typeof provider.id !== "string" || !provider.id.trim() || typeof provider.provideDiagnostics !== "function") {
			throw new TypeError("A diagnostic provider requires a nonempty id and provideDiagnostics(context).");
		}
		if (providers.has(provider.id)) throw new Error("Diagnostic provider already registered: " + provider.id);
		const record = { provider, workspaces: new Map(), disposed: false };
		providers.set(provider.id, record);
		for (const folder of folders()) schedule(stateFor(record, folder), "initial");
		return Object.freeze({
			refresh: (folderOrUri, callerOptions = {}) => {
				const folder = resolveFolder(folderOrUri);
				if (!folder) return Promise.resolve(undefined);
				return run(stateFor(record, folder), "manual", undefined, callerOptions);
			},
			dispose: () => {
				if (record.disposed) return;
				record.disposed = true;
				providers.delete(provider.id);
				for (const state of record.workspaces.values()) {
					state.disposed = true;
					clearState(state);
					state.collection.dispose();
				}
				record.workspaces.clear();
			},
		});
	}

	function resolveFolder(folderOrUri) {
		if (!folderOrUri) return undefined;
		const candidate = folderOrUri.uri || folderOrUri;
		const root = candidate.fsPath || candidate.path;
		return folders().find((folder) => sameRoot(folder.uri.fsPath, root));
	}

	function onDidChangeWorkspaceFolders(listener) {
		if (typeof listener !== "function") throw new TypeError("Workspace listener must be a function.");
		workspaceListeners.add(listener);
		return { dispose: () => workspaceListeners.delete(listener) };
	}

	function refreshDiagnostics(providerId, folderOrUri, callerOptions) {
		const record = providers.get(providerId);
		if (!record) return Promise.reject(new Error("Unknown diagnostic provider: " + providerId));
		const folder = resolveFolder(folderOrUri);
		if (!folder) return Promise.resolve(undefined);
		return run(stateFor(record, folder), "manual", undefined, callerOptions);
	}

	function subscribe(event, callback) {
		if (event) subscriptions.push(event(callback, undefined, subscriptions));
	}
	subscribe(vscode.workspace.onDidOpenTextDocument, (document) => scheduleAll("document-open", document));
	subscribe(vscode.workspace.onDidChangeTextDocument, (event) => scheduleAll("document-change", event.document));
	subscribe(vscode.workspace.onDidSaveTextDocument, (document) => scheduleAll("document-save", document));
	subscribe(vscode.workspace.onDidChangeConfiguration, () => scheduleAll("configuration-change"));
	if (vscode.workspace.onDidChangeWorkspaceFolders) {
		subscribe(vscode.workspace.onDidChangeWorkspaceFolders, (event) => {
			for (const folder of event.removed) {
				const removedRoot = path.resolve(folder.uri.fsPath);
				watchers.get(removedRoot)?.dispose();
				watchers.delete(removedRoot);
				for (const record of providers.values()) {
					const state = record.workspaces.get(removedRoot);
					if (state) {
						state.disposed = true;
						clearState(state);
						state.collection.dispose();
						record.workspaces.delete(removedRoot);
					}
				}
			}
			for (const folder of event.added) {
				attachFolderWatchers(folder);
				for (const record of providers.values()) schedule(stateFor(record, folder), "workspace-added");
			}
			for (const listener of workspaceListeners) listener(event);
		});
	}
	for (const folder of folders()) attachFolderWatchers(folder);

	const api = Object.freeze({
		apiVersion: 1,
		getWorkspaceFolders: () => folders().slice(),
		onDidChangeWorkspaceFolders,
		registerDiagnosticProvider,
		refreshDiagnostics,
	});

	function dispose() {
		for (const record of providers.values()) {
			for (const state of record.workspaces.values()) {
				state.disposed = true;
				clearState(state);
				state.collection.dispose();
			}
		}
		providers.clear();
		for (const timer of timers) clearTimeout(timer);
		timers.clear();
		for (const item of subscriptions.splice(0)) item.dispose?.();
		watchers.clear();
		workspaceListeners.clear();
	}
	context?.subscriptions?.push({ dispose });
	return { api, dispose };
}

module.exports = { createDiagnosticHost, sameRoot, withinRoot };
