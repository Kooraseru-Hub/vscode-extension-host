"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function createBridgeSession({ vscode, extensionContext, workspaceFolder, invokeCallback, moduleLoader } = {}) {
	if (!vscode || !extensionContext || !workspaceFolder || typeof invokeCallback !== "function") throw new TypeError("vscode, extensionContext, workspaceFolder, and invokeCallback are required");
	const refs = new Map();
	const objectIds = new WeakMap();
	const owned = new Set();
	const requests = new Map();
	const subscriptions = new Map();
	const modules = new Set();
	const moduleIdentities = new WeakMap();
	const nativeExceptions = new WeakSet();
	const connectionController = new AbortController();
	let nextRef = 1;
	let disposed = false;
	const workspaceRoot = workspaceFolder.uri?.fsPath || workspaceFolder.fsPath || String(workspaceFolder);

	function refFor(value, takeOwnership = false) {
		let id = objectIds.get(value);
		if (!id || !refs.has(id)) { id = String(nextRef++); objectIds.set(value, id); refs.set(id, value); }
		if (takeOwnership) owned.add(value);
		return { $type: "ref", id };
	}
	function encode(value, seen = new Set()) {
		if (value === undefined) return { $type: "undefined" };
		if (value === null || typeof value === "string" || typeof value === "boolean") return value;
		if (typeof value === "number") return Number.isFinite(value) ? value : { $type: "number", value: Number.isNaN(value) ? "NaN" : value > 0 ? "+Infinity" : "-Infinity" };
		if (typeof value === "bigint") return { $type: "bigint", value: value.toString() };
		if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { $type: "bytes", data: Buffer.from(value).toString("base64") };
		if (typeof value === "object" && seen.has(value)) throw new TypeError("Cannot encode cyclic snapshot");
		return refFor(value);
	}
	function decode(value, callbackSignal = connectionController.signal) {
		if (!value || typeof value !== "object") return value;
		switch (value.$type) {
		case "undefined": return undefined;
		case "number": return value.value === "NaN" ? NaN : value.value === "+Infinity" ? Infinity : -Infinity;
		case "bigint": return BigInt(value.value);
		case "bytes": return Buffer.from(value.data, "base64");
		case "ref": { if (!refs.has(String(value.id))) throw new Error(`Unknown reference: ${value.id}`); return refs.get(String(value.id)); }
		case "callback": return (...args) => Promise.resolve().then(() => invokeCallback(value.id, args.map((arg) => encode(arg)), AbortSignal.any([callbackSignal, connectionController.signal]))).then((wire) => decode(wire, callbackSignal));
		case "array": return value.items.map((item) => decode(item, callbackSignal));
		case "object": { const result = {}; for (const [key, item] of value.entries) Object.defineProperty(result, key, { value: decode(item, callbackSignal), enumerable: true, configurable: true, writable: true }); return result; }
		default: throw new TypeError(`Unknown wire value type: ${value.$type || "object"}`);
		}
	}
	function targetObject(target) {
		if (target === "vscode") return vscode;
		if (target === "context") return extensionContext;
		if (target?.$type === "ref") return decode(target);
		throw new TypeError("target must be 'vscode', 'context', or a reference");
	}
	function resolve(target, pathParts) {
		if (!Array.isArray(pathParts)) throw new TypeError("path must be an array of property names");
		let value = targetObject(target), receiver;
		for (const key of pathParts) {
			if (typeof key !== "string") throw new TypeError("path entries must be strings");
			receiver = value; value = value[key];
		}
		return { value, receiver };
	}
	function snapshot(value, ancestors = new Set()) {
		if (value === undefined || value === null || ["string", "boolean", "number", "bigint"].includes(typeof value)) return encode(value);
		if (Buffer.isBuffer(value) || value instanceof Uint8Array) return encode(value);
		if (typeof value !== "object") return encode(value);
		if (ancestors.has(value)) throw new TypeError("Cannot snapshot cyclic value");
		const proto = Object.getPrototypeOf(value);
		if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) return refFor(value);
		ancestors.add(value);
		let result;
		if (Array.isArray(value)) result = { $type: "array", items: value.map((item) => snapshot(item, ancestors)) };
		else result = { $type: "object", entries: Object.keys(value).map((key) => [key, snapshot(value[key], ancestors)]) };
		ancestors.delete(value);
		return result;
	}
	function disposeValue(value) {
		try { if (typeof value?.dispose === "function") value.dispose(); else if (typeof value?.unsubscribe === "function") value.unsubscribe(); } catch { /* best-effort cleanup */ }
	}
	function cancel(requestId) {
		const entry = requests.get(String(requestId));
		if (entry) { entry.controller.abort(); entry.cancelled = true; }
		return Boolean(entry);
	}
	function disposeModuleSubscriptions(record) {
		for (const item of [...record.subscriptions].reverse()) {
			if (!item || record.disposedSubscriptions.has(item)) continue;
			record.disposedSubscriptions.add(item); disposeValue(item);
		}
	}
	async function cleanupModule(record) {
		if (!record.closing) {
			record.closing = true;
			record.controller.abort();
			record.removeAbortListener?.(); record.removeAbortListener = undefined;
		}
		disposeModuleSubscriptions(record);
		if (!record.activationDone) return;
		if (record.cleanupPromise) return record.cleanupPromise;
		record.cleaned = true;
		record.cleanupPromise = (async () => {
			try {
				if (record.result && typeof record.result.dispose === "function" && !record.disposedSubscriptions.has(record.result)) {
					record.disposedSubscriptions.add(record.result); disposeValue(record.result);
				}
				if (typeof record.mod.deactivate === "function") await record.mod.deactivate();
			} finally {
				modules.delete(record);
				for (const [id, value] of refs) if (value === record.api) { refs.delete(id); owned.delete(value); }
				if (record.api) { const records = moduleIdentities.get(record.api); records?.delete(record); if (records?.size === 0) moduleIdentities.delete(record.api); }
			}
		})();
		return record.cleanupPromise;
	}
	async function loadModule(params, signal) {
		if (typeof params?.path !== "string") throw new TypeError("loadModule requires path");
		const root = await fs.realpath(workspaceRoot);
		const candidate = await fs.realpath(path.resolve(root, params.path));
		const rel = path.relative(root, candidate);
		if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Module path must stay within workspace");
		if (signal.aborted) throw new Error("Request cancelled");
		const mod = moduleLoader ? await moduleLoader(candidate) : await import(pathToFileURL(candidate).href);
		if (signal.aborted || disposed) throw new Error("Request cancelled");
		if (typeof mod.activate !== "function") throw new TypeError("Workspace module must export activate(context)");
		const controller = new AbortController();
		const context = { vscode, extensionContext, workspaceFolder, subscriptions: [], signal: controller.signal, asAbsolutePath: (relative) => {
			const absolute = path.resolve(workspaceRoot, relative);
			const rel = path.relative(workspaceRoot, absolute);
			if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("Path must stay within workspace");
			return absolute;
		} };
		const record = { mod, controller, subscriptions: context.subscriptions, result: undefined, activationDone: false, closing: false, cleaned: false, disposedSubscriptions: new Set() };
		modules.add(record);
		const originalPush = context.subscriptions.push.bind(context.subscriptions);
		context.subscriptions.push = (...items) => { const length = originalPush(...items); if (record.closing) disposeModuleSubscriptions(record); return length; };
		record.removeAbortListener = () => signal.removeEventListener("abort", abortForModule);
		const abortForModule = () => { void cleanupModule(record).catch(() => {}); };
		signal.addEventListener("abort", abortForModule, { once: true });
		let result;
		try { result = await mod.activate(context); }
		catch (error) {
			record.activationDone = true;
			record.result = undefined;
			try { await cleanupModule(record); } catch { /* preserve activation error */ }
			throw error;
		}
		record.result = result;
		record.activationDone = true;
		if (signal.aborted || disposed) {
			await cleanupModule(record);
			throw new Error("Request cancelled");
		}
		const api = result && (typeof result === "object" || typeof result === "function") ? result : mod;
		record.api = api;
		let identityRecords = moduleIdentities.get(api);
		if (!identityRecords) { identityRecords = new Set(); moduleIdentities.set(api, identityRecords); }
		identityRecords.add(record);
		return refFor(api);
	}
	async function execute(method, params, signal) {
		if (!["get", "set", "call", "construct", "subscribe", "unsubscribe", "snapshot", "release", "loadModule", "dispose"].includes(method)) throw Object.assign(new Error(`Unsupported method: ${method}`), { code: -32601 });
		if (method === "dispose") {
			const id = String(params?.target?.id ?? params?.id ?? "");
			if (!id || !refs.has(id)) throw new Error("Unknown reference");
			const value = refs.get(id); const records = moduleIdentities.get(value);
			if (records?.size) for (const record of [...records]) await cleanupModule(record);
			else disposeValue(value);
			owned.delete(value); refs.delete(id); subscriptions.delete(id);
			return { $type: "undefined" };
		}
		if (method === "release") { const id = String(params?.target?.id ?? params?.id); refs.delete(id); return { $type: "undefined" }; }
		if (method === "loadModule") return loadModule(params, signal);
		if (method === "snapshot") { const { value } = resolve(params.target, params.path || []); return snapshot(value); }
		if (method === "get" || method === "set" || method === "call" || method === "construct" || method === "subscribe") {
			const pathParts = params.path || [];
			if (method === "set") {
				if (!Array.isArray(pathParts) || pathParts.length === 0 || pathParts.some(key => typeof key !== "string")) throw new TypeError("set requires a non-empty path array");
				const parent = resolve(params.target, pathParts.slice(0, -1)).value;
				const assigned = decode(params.value);
				parent[pathParts.at(-1)] = assigned;
				return encode(assigned);
			}
			const { value, receiver } = resolve(params.target, pathParts);
			if (method === "get") return encode(value);
			if (method === "call") {
				if (typeof value !== "function") throw new TypeError("Target is not callable");
				let result;
				try { result = await value.apply(receiver, (params.args || []).map((arg) => decode(arg, signal))); }
				catch (error) { if (error && (typeof error === "object" || typeof error === "function")) nativeExceptions.add(error); throw error; }
				return params.owned && result !== null && (typeof result === "object" || typeof result === "function") ? refFor(result, true) : encode(result);
			}
			if (method === "construct") {
				if (typeof value !== "function") throw new TypeError("Target is not a constructor");
				let instance;
				try { instance = Reflect.construct(value, (params.args || []).map((arg) => decode(arg, signal))); }
				catch (error) { if (error && (typeof error === "object" || typeof error === "function")) nativeExceptions.add(error); throw error; }
				return refFor(instance, Boolean(params.owned));
			}
			if (method === "subscribe") {
				const callback = decode(params.callback);
				if (typeof value !== "function" || typeof callback !== "function") throw new TypeError("subscribe requires an event and callback");
				const disposable = value.call(receiver, (...args) => { Promise.resolve().then(() => invokeCallback(params.callback.id, args.map((arg) => encode(arg)), connectionController.signal)).then((wire) => decode(wire)).catch(() => {}); });
				const ref = refFor(disposable, true); subscriptions.set(ref.id, disposable); return ref;
			}
		}
		if (method === "unsubscribe") { const id = String(params.subscription?.id); const value = refs.get(id); if (value) { disposeValue(value); owned.delete(value); refs.delete(id); subscriptions.delete(id); } return { $type: "undefined" }; }
		throw new TypeError(`Unsupported method: ${method}`);
	}
	async function dispatch(method, params = {}, requestId) {
		if (disposed) throw new Error("Bridge session is disposed");
		const id = requestId === undefined ? undefined : String(requestId);
		const entry = { controller: new AbortController(), cancelled: false };
		if (id !== undefined) requests.set(id, entry);
		let onAbort;
		const execution = execute(method, params, entry.controller.signal);
		const lateCleanup = (value) => {
			if (!entry.cancelled || value?.$type !== "ref") return;
			const resource = refs.get(String(value.id));
			if (owned.has(resource)) { disposeValue(resource); owned.delete(resource); }
			refs.delete(String(value.id));
		};
		execution.then(lateCleanup, () => {});
		const aborted = new Promise((_, reject) => {
			onAbort = () => reject(Object.assign(new Error("Request cancelled"), { code: -32800 }));
			entry.controller.signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			const value = await Promise.race([execution, aborted]);
			if (entry.cancelled) {
				if (value?.$type === "ref") {
					const resource = refs.get(value.id);
					if (owned.has(resource)) { disposeValue(resource); owned.delete(resource); }
					refs.delete(String(value.id));
				}
				throw new Error("Request cancelled");
			}
			return value;
		} catch (error) {
			if (!error?.code && error instanceof TypeError && !nativeExceptions.has(error)) error.code = -32602;
			throw error;
		}
		finally { entry.controller.signal.removeEventListener("abort", onAbort); if (id !== undefined) requests.delete(id); }
	}
	async function dispose() {
		if (disposed) return; disposed = true;
		connectionController.abort();
		for (const entry of requests.values()) { entry.cancelled = true; entry.controller.abort(); } requests.clear();
		for (const record of [...modules]) { try { await cleanupModule(record); } catch { /* best-effort cleanup */ } }
		for (const value of owned) disposeValue(value);
		owned.clear(); refs.clear(); subscriptions.clear();
	}
	return { dispatch, cancel, dispose };
}

module.exports = { createBridgeSession };
