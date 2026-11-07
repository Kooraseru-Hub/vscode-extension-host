"use strict";
const crypto = require("node:crypto");

class RpcError extends Error {
	constructor(message, code = -32000, data) { super(message); this.name = "RpcError"; this.code = code; this.data = data; }
}
class RpcPeer {
	constructor(socket, { onRequest, onNotification } = {}) {
		this.socket = socket;
		this.onRequest = onRequest;
		this.onNotification = onNotification;
		this.pending = new Map();
		this.listeners = new Set();
		this.sequence = 0;
		this.prefix = crypto.randomBytes(8).toString("hex");
		this.disposed = false;
		this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
		socket.on("message", data => { void this.receive(data); });
		socket.on("close", () => this.finish());
		socket.on("error", () => this.finish());
	}
	send(message) {
		if (this.disposed || this.socket.readyState !== 1) throw new RpcError("Bridge connection is closed.", -32010);
		this.socket.send(JSON.stringify(message));
	}
	request(method, params, { signal } = {}) {
		if (signal?.aborted) return Promise.reject(new RpcError("Request cancelled.", -32800));
		const id = `${this.prefix}-${++this.sequence}`;
		return new Promise((resolve, reject) => {
			const abort = () => {
				this.pending.delete(id);
				cleanup();
				try { this.notify("$/cancelRequest", { id }); } catch { /* Disconnected. */ }
				reject(new RpcError("Request cancelled.", -32800));
			};
			const cleanup = () => signal?.removeEventListener("abort", abort);
			this.pending.set(id, { resolve, reject, cleanup });
			signal?.addEventListener("abort", abort, { once: true });
			try { this.send({ jsonrpc: "2.0", id, method, params }); }
			catch (error) { this.pending.delete(id); cleanup(); reject(error); }
		});
	}
	notify(method, params) { this.send({ jsonrpc: "2.0", method, params }); }
	async receive(data) {
		let message;
		try { message = JSON.parse(data.toString()); }
		catch { return this.respond({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Invalid JSON." } }); }
		if (!message || message.jsonrpc !== "2.0" || typeof message !== "object" || Array.isArray(message)) {
			return this.respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid JSON-RPC request." } });
		}
		if (typeof message.method === "string") {
			if (message.id === undefined) {
				try { await this.onNotification?.(message.method, message.params); } catch { /* Notifications have no response. */ }
				return;
			}
			if (typeof message.id !== "string" && typeof message.id !== "number") return this.respond({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request id." } });
			try {
				if (!this.onRequest) throw new RpcError("No request handler.", -32601);
				const result = await this.onRequest(message.method, message.params, message.id);
				this.respond({ jsonrpc: "2.0", id: message.id, result });
			} catch (error) {
				this.respond({ jsonrpc: "2.0", id: message.id, error: { code: Number.isInteger(error?.code) ? error.code : -32000, message: error?.message || String(error), ...(error?.data === undefined ? {} : { data: error.data }) } });
			}
		} else {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			pending.cleanup();
			if (message.error) pending.reject(new RpcError(message.error.message, message.error.code, message.error.data));
			else if (Object.hasOwn(message, "result")) pending.resolve(message.result);
			else pending.reject(new RpcError("Malformed RPC response.", -32600));
		}
	}
	respond(message) { try { this.send(message); } catch { /* The connection may close during a native API operation. */ } }
	onClose(listener) { if (this.disposed) queueMicrotask(listener); else this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) }; }
	finish() {
		if (this.disposed) return;
		this.disposed = true;
		for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(new RpcError("Bridge disconnected.", -32010)); }
		this.pending.clear();
		for (const listener of this.listeners) { try { listener(); } catch { /* Isolate clients. */ } }
		this.listeners.clear(); this.resolveClosed();
	}
	close() { this.socket.close(); this.finish(); }
}
module.exports = { RpcPeer, RpcError };
