"use strict";
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");

function rejectLink(file) {
	let current = path.resolve(file);
	while (true) {
		try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error("Private discovery paths cannot be symbolic links."); }
		catch (error) { if (error.code !== "ENOENT") throw error; }
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
}
function windowsIdentity() {
	const identity = process.env.USERDOMAIN && process.env.USERNAME ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}` : process.env.USERNAME;
	if (!identity) throw new Error("Cannot determine current Windows account for private discovery ACL.");
	return identity;
}
function protectDirectory(directory) {
	rejectLink(directory);
	if (process.platform === "win32") {
		const identity = windowsIdentity();
		const reset = spawnSync("icacls.exe", [directory, "/reset"], { encoding: "utf8", windowsHide: true });
		const result = reset.status === 0 && !reset.error ? spawnSync("icacls.exe", [directory, "/inheritance:r", "/grant:r", `${identity}:(OI)(CI)F`], { encoding: "utf8", windowsHide: true }) : reset;
		if (result.error || result.status !== 0) throw new Error("Could not secure the private discovery directory ACL.");
		return;
	}
	const stat = fs.statSync(directory);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Private discovery directory is owned by another account.");
	fs.chmodSync(directory, 0o700);
}
function protectFile(file) {
	rejectLink(file);
	if (process.platform === "win32") {
		const identity = windowsIdentity();
		const reset = spawnSync("icacls.exe", [file, "/reset"], { encoding: "utf8", windowsHide: true });
		const result = reset.status === 0 && !reset.error ? spawnSync("icacls.exe", [file, "/inheritance:r", "/grant:r", `${identity}:F`], { encoding: "utf8", windowsHide: true }) : reset;
		if (result.error || result.status !== 0) throw new Error("Could not secure the private discovery record ACL.");
		return;
	}
	const stat = fs.statSync(file);
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("Private discovery record is owned by another account.");
	fs.chmodSync(file, 0o600);
}

function canonicalWorkspace(workspace) {
	const real = fs.realpathSync(path.resolve(workspace));
	return process.platform === "win32" ? real.toLowerCase() : real;
}
function sessionDirectory({ workspace, discoveryRoot } = {}) {
	const hash = crypto.createHash("sha256").update(canonicalWorkspace(workspace || process.cwd())).digest("hex");
	return path.join(discoveryRoot || path.join(os.tmpdir(), "workbench-bridge"), hash, "sessions");
}
function readSession(file) {
	const value = JSON.parse(fs.readFileSync(file, "utf8"));
	if (!value || typeof value.sessionId !== "string" || typeof value.endpoint !== "string" || typeof value.token !== "string" || typeof value.workspace !== "string" || !Number.isInteger(value.pid)) throw new Error("Invalid Workbench Bridge session record.");
	const endpoint = new URL(value.endpoint);
	if (endpoint.protocol !== "ws:" || !["127.0.0.1", "[::1]", "localhost"].includes(endpoint.hostname)) throw new Error("Discovery requires a loopback WebSocket endpoint. Use an explicit endpoint for forwarded connections.");
	return { ...value, sessionFile: file };
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } }
function listSessions(options = {}) {
	const directory = sessionDirectory(options);
	if (!fs.existsSync(directory)) return [];
	return fs.readdirSync(directory).filter(name => name.endsWith(".json")).flatMap(name => {
		try { const value = readSession(path.join(directory, name)); return alive(value.pid) && canonicalWorkspace(value.workspace) === canonicalWorkspace(options.workspace || process.cwd()) ? [value] : []; } catch { return []; }
	}).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}
function readDiscovery(options = {}) {
	const file = options.sessionFile || process.env.WORKBENCH_BRIDGE_SESSION;
	if (file) {
		const session = readSession(file);
		if (options.workspace && canonicalWorkspace(options.workspace) !== canonicalWorkspace(session.workspace)) throw new Error("Bridge session belongs to another workspace.");
		return session;
	}
	const sessions = listSessions(options).filter(session => !options.sessionId || session.sessionId === options.sessionId);
	if (sessions.length !== 1) throw new Error(sessions.length ? "Multiple VS Code sessions match this workspace; select a sessionId or sessionFile." : "No Workbench Bridge session found for this workspace.");
	return sessions[0];
}
function writeDiscovery(record, discoveryRoot) {
	const root = path.resolve(discoveryRoot || path.join(os.tmpdir(), "workbench-bridge"));
	const directory = sessionDirectory({ workspace: record.workspace, discoveryRoot: root });
	rejectLink(directory);
	fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
	for (const candidate of [root, path.dirname(path.dirname(directory)), path.dirname(directory), directory]) {
		if (!fs.existsSync(candidate)) continue;
		protectDirectory(candidate);
	}
	const file = path.join(directory, `${record.sessionId}.json`);
	fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n", { mode: 0o600, flag: "wx" });
	protectFile(file);
	return { file, dispose() {
		try { const current = readSession(file); if (current.token === record.token) fs.unlinkSync(file); } catch { /* Already removed. */ }
	} };
}
module.exports = { canonicalWorkspace, sessionDirectory, listSessions, readDiscovery, writeDiscovery };
