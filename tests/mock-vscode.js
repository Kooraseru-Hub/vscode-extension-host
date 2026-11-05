"use strict";

const path = require("node:path");

class Emitter {
	constructor() { this.listeners = new Set(); }
	event(listener, _thisArgs, disposables) {
		this.listeners.add(listener);
		const disposable = { dispose: () => this.listeners.delete(listener) };
		disposables?.push(disposable);
		return disposable;
	}
	fire(value) { for (const listener of [...this.listeners]) listener(value); }
}

class Position {
	constructor(line, character) { this.line = line; this.character = character; }
	translate(lines, characters) { return new Position(this.line + lines, this.character + characters); }
}

class Range {
	constructor(start, end) { this.start = start; this.end = end; }
}

function makeDocument(root, relative, text, options = {}) {
	const filePath = path.join(root, relative);
	return {
		uri: { scheme: "file", fsPath: filePath, path: filePath, toString: () => "file:///" + filePath.replaceAll("\\", "/") },
		languageId: options.languageId || "plaintext",
		version: options.version || 1,
		isDirty: Boolean(options.isDirty),
		getText: () => text,
		setText(value) { text = value; this.version++; this.isDirty = true; },
	};
}

function makeVscode(roots) {
	const events = {
		open: new Emitter(), change: new Emitter(), save: new Emitter(), config: new Emitter(), folders: new Emitter(),
	};
	const watchers = [];
	const collections = [];
	const workspace = {
		workspaceFolders: roots.map((root, index) => ({ name: "workspace-" + index, index, uri: { scheme: "file", fsPath: root, path: root, toString: () => "file:///" + root.replaceAll("\\", "/") } })),
		textDocuments: [],
		getWorkspaceFolder(uri) { return this.workspaceFolders.find((folder) => {
			const relative = path.relative(folder.uri.fsPath, uri.fsPath || uri.path || "");
			return relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative));
		}); },
		onDidOpenTextDocument: events.open.event.bind(events.open),
		onDidChangeTextDocument: events.change.event.bind(events.change),
		onDidSaveTextDocument: events.save.event.bind(events.save),
		onDidChangeConfiguration: events.config.event.bind(events.config),
		onDidChangeWorkspaceFolders: events.folders.event.bind(events.folders),
		createFileSystemWatcher(pattern) {
			const watcher = { pattern, create: new Emitter(), change: new Emitter(), delete: new Emitter(), disposed: false,
				onDidCreate: (listener, thisArgs, disposables) => watcher.create.event(listener, thisArgs, disposables),
				onDidChange: (listener, thisArgs, disposables) => watcher.change.event(listener, thisArgs, disposables),
				onDidDelete: (listener, thisArgs, disposables) => watcher.delete.event(listener, thisArgs, disposables),
				dispose() { this.disposed = true; },
			};
			watchers.push(watcher);
			return watcher;
		},
	};
	return {
		workspace,
		watchers,
		collections,
		events,
		Position,
		Range,
		Diagnostic: class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
		DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
		Uri: { file(fsPath) { return { scheme: "file", fsPath, path: fsPath, toString: () => "file:///" + fsPath.replaceAll("\\", "/") }; } },
		RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
		languages: { createDiagnosticCollection(name) {
			const entries = new Map();
			const collection = { name, entries, clear() { entries.clear(); }, set(uri, diagnostics) { entries.set(uri.toString(), diagnostics); }, dispose() { this.disposed = true; entries.clear(); } };
			collections.push(collection);
			return collection;
		} },
	};
}

module.exports = { makeVscode, makeDocument };
