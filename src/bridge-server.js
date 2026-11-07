"use strict";
const crypto = require("node:crypto");
const { WebSocketServer } = require("ws");
const { RpcPeer, RpcError } = require("./rpc-peer");
const { createBridgeSession } = require("./bridge-session");
const { canonicalWorkspace, writeDiscovery } = require("./discovery");

function tokenMatches(actual, expected) {
	if (typeof actual !== "string") return false;
	const left = Buffer.from(actual), right = Buffer.from(expected);
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}
async function startBridgeServer({ vscode, extensionContext, workspaceFolder, discoveryRoot, maxPayload = 64 * 1024 * 1024, onError = () => {} }) {
	if (vscode.workspace.isTrusted !== true) throw new RpcError("Workspace trust is required.", -32002);
	const workspace = canonicalWorkspace(workspaceFolder.uri.fsPath);
	const sessionId = crypto.randomUUID();
	const token = crypto.randomBytes(32).toString("hex");
	const connections = new Set();
	const cleanups = new Set();
	let disposed = false;
	const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: `/bridge/${sessionId}`, maxPayload,
		verifyClient: info => info.req.headers.origin === undefined && vscode.workspace.isTrusted === true && !disposed,
	});
	server.on("connection", socket => {
		let authenticated = false;
		let session;
		const timer = setTimeout(() => socket.close(1008, "Authentication required"), 5000);
		const peer = new RpcPeer(socket, {
			async onRequest(method, params, id) {
				if (disposed || vscode.workspace.isTrusted !== true) throw new RpcError("Workspace trust is required.", -32002);
				if (!authenticated) {
					let matchingWorkspace = false;
					try { matchingWorkspace = canonicalWorkspace(params?.workspace || workspace) === workspace; } catch { /* Invalid workspace. */ }
					if (method !== "connect" || !tokenMatches(params?.token, token) || !matchingWorkspace) {
						setImmediate(() => socket.close(1008, "Unauthorized"));
						throw new RpcError("Bridge authentication failed.", -32001);
					}
					authenticated = true;
					clearTimeout(timer);
					session = createBridgeSession({ vscode, extensionContext, workspaceFolder,
						invokeCallback: (callbackId, args, signal) => peer.request("callback", { id: callbackId, args }, { signal }),
					});
					return { sessionId, workspace };
				}
				return session.dispatch(method, params || {}, id);
			},
			onNotification(method, params) {
				if (authenticated && method === "$/cancelRequest") session.cancel(params?.id);
			},
		});
		const connection = { socket, peer };
		connections.add(connection);
		peer.onClose(() => {
			clearTimeout(timer); connections.delete(connection);
			const cleanup = Promise.resolve(session?.dispose()).catch(onError);
			cleanups.add(cleanup);
			void cleanup.finally(() => cleanups.delete(cleanup));
		});
	});
	await new Promise((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
	server.on("error", onError);
	const address = server.address();
	let discovery;
	try {
		discovery = writeDiscovery({ sessionId, workspace, endpoint: `ws://127.0.0.1:${address.port}/bridge/${sessionId}`, token, pid: process.pid,
			title: workspaceFolder.name, createdAt: new Date().toISOString() }, discoveryRoot);
	} catch (error) { server.close(); throw error; }
	return { sessionFile: discovery.file, sessionId, workspace, async dispose() {
		if (disposed) return;
		disposed = true;
		discovery.dispose();
		for (const connection of connections) { connection.peer.close(); connection.socket.terminate(); }
		await new Promise(resolve => server.close(resolve));
		await Promise.allSettled([...cleanups]);
	} };
}
module.exports = { startBridgeServer };
