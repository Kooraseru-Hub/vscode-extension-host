# Workbench Bridge

Expose VS Code functionality to external workspace programs without building a dedicated extension.

Install **Workbench Bridge** in VS Code. Run your dependency loader, checks, automation, or other tools as ordinary Node, Python, Luau, or other programs. The bridge runs in the workspace extension host, including WSL, SSH, and containers. Callers normally run beside it; explicitly selected endpoints support forwarded connections.

The public contract is versionless: generic property access, invocation, construction, events, callbacks, object references, and workspace modules. New workspace features use these operations rather than adding bridge endpoints.

## Quick start

Requires a trusted, file-backed workspace. Install the VSIX produced by `npm run package:vsix`, or install `Kooraseru.workbench-bridge` when available in the Marketplace. The display name is **Workbench Bridge**.

```js
const { connect } = require("workbench-bridge/client");
const bridge = await connect({ workspace: process.cwd() });
const status = await bridge.call({
  target: "vscode",
  path: ["window", "createStatusBarItem"],
  args: [1],
  owned: true,
});
await bridge.set({ target: status, path: ["text"], value: "$(sync~spin) Loading dependencies" });
await bridge.call({ target: status, path: ["show"] });
// Perform your work, then release the UI.
await bridge.dispose({ target: status });
bridge.close();
```

From this checkout use `require("./client")`. Node 22+ uses its native WebSocket; Node 20 uses the packaged `ws` dependency. Every remote operation is asynchronous. Returned objects are identity-preserving handles; use `get`, `call`, or `snapshot` to access them.

Other extensions are accessible through `vscode.extensions.getExtension(...).activate()`; their exports use the same handles and operations.

## Workspace startup

```json
{
  "workbenchBridge.workspaceCommands": [
    ["node", "tools/editor-client.cjs"]
  ]
}
```

Commands start after discovery is ready and receive `WORKBENCH_BRIDGE_SESSION`. They stop with the workspace connection. Arrays are executable and arguments, without shell interpretation. Workspace programs decide what loading/checking means, run the actual tools, and publish native status items and diagnostics.

Recommended extension:

```json
{ "recommendations": ["Kooraseru.workbench-bridge"] }
```

The settings namespace is `workbenchBridge`. Available settings are `enabled`, `workspaceCommands`, and `maxMessageBytes`. Commands **Workbench Bridge: Show Output** and **Restart Workspace Connections** expose logs and restart connections.

## Callbacks and synchronous APIs

Asynchronous callbacks run in the external caller and can return native objects through handles or ordinary data. Events use `subscribe` and `unsubscribe`.

Synchronous callbacks must run inside VS Code. Put that routine in a workspace JS/TS module exporting `activate(context)`, then call its exports through `loadModule`. For example, a module can call `TextEditor.edit(builder => ...)` synchronously while its exported routine remains callable from any language. See [the protocol and module contract](docs/protocol.md).

The bridge uses the JavaScript/TypeScript module loading supported by its extension-host Node runtime. CommonJS `.cjs` and ESM `.mjs` work directly; TypeScript requires native type stripping on a compatible runtime or a workspace transpilation hook/build. Loading TypeScript does not replace type checking.

## Languages and discovery

- [JavaScript/TypeScript SDK and declarations](client/index.d.ts)
- [Runnable Python example](examples/python_statusbar.py): `python -m pip install websockets`, then `python examples/python_statusbar.py --once`.
- [Runnable Luau/Lute example](examples/lute_statusbar.luau): `lute examples/lute_statusbar.luau --once`.

Examples read `WORKBENCH_BRIDGE_SESSION`. The JS SDK can discover a single session automatically; with multiple matching windows select `sessionId` or `sessionFile`. Explicit `endpoint` and `token` support forwarding. Discovery records live outside the repository, contain credentials, and must not be committed or logged.

## Security and lifetime

Full bridge access has extension-level privileges. This is a trusted-code bridge, not a sandbox. It starts only for trusted workspaces, listens on loopback, authenticates before API access, and rejects browser-origin connections.

Handles, callbacks, requests, subscriptions, and modules belong to a connection. Use `owned: true` for newly created resources you want cleaned up on disconnect. Borrowed resources, such as an existing user terminal, are not disposed implicitly. Modules have cancellation signals and subscription cleanup; module paths must resolve inside the selected workspace.

## Development and verification

```text
npm ci
npm test
npm run test:vscode
npm run package:vsix
```

Native tests launch an isolated VS Code development host. Set `VSCODE_EXECUTABLE` if it cannot locate VS Code, `BRIDGE_TEST_LUTE` to a Lute executable, and optionally `BRIDGE_TEST_NODE`/`BRIDGE_TEST_PYTHON`. Python needs `websockets`. Native tests exercise real external Node, Python and Luau connections, native UI objects, commands, extension exports, events, diagnostics, binary file operations, asynchronous providers, synchronous editor edits, and native errors. The unit/contract suite covers transport, trust, authentication, discovery ambiguity, cancellation, ownership, modules, and cleanup.

The [protocol](docs/protocol.md) is the compatibility contract. After this implementation pass, bridge maintenance is limited to defects and VS Code integration changes.

ISC License.
