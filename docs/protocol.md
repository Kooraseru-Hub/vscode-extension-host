# Workbench Bridge protocol

The public interface is versionless. There is no product API version, negotiation, feature endpoint registry, or per-API whitelist. VS Code availability still depends on the installed editor and its enabled APIs/extensions.

## Transport and authentication

Use a loopback WebSocket and UTF-8 JSON-RPC 2.0 messages. The JSON-RPC standard marker `"jsonrpc":"2.0"` is not a bridge API version. Both peers can send requests while another request is outstanding. IDs are strings or numbers and must be unique among a peer's outstanding requests. Responses have `result` or `error:{code,message,data?}`.

The first request must be:

```json
{"jsonrpc":"2.0","id":"hello","method":"connect","params":{"token":"<discovery token>","workspace":"<absolute workspace path>"}}
```

Workspace may be omitted when explicitly connecting to the endpoint assigned to that workspace. Result is `{sessionId,workspace}`. No API requests are accepted before authentication. Wrong tokens/workspaces close the connection; authentication has a five-second deadline. Browser `Origin` headers are rejected even before authentication. The extension rechecks workspace trust on requests.

Default maximum message size is 64 MiB, configurable through `workbenchBridge.maxMessageBytes`. JSON-RPC batches and arbitrary binary WebSocket frames are not part of this contract; binary values use the encoding below.

## Discovery

Files live under the OS temporary directory:
`workbench-bridge/<sha256 canonical workspace>/sessions/<session UUID>.json`.

A descriptor contains `sessionId, workspace, endpoint, token, pid, title, createdAt`. Directories and records are restricted to the owner. One live matching session is selected automatically; multiple sessions require explicit `sessionId` or `sessionFile`. A supplied `WORKBENCH_BRIDGE_SESSION` takes precedence over automatic discovery. The SDK accepts `discoveryRoot` for isolated environments/tests. The descriptor identifies the workspace-side environment; local and remote hosts have separate discovery.

Explicit `endpoint` plus `token` bypass discovery for forwarding. Treat the token as a credential granting extension-level access. Neither the server nor client prints tokens. Do not put descriptors in the repository.

## Values and identity

Primitives (`null`, strings, booleans, finite numbers) are plain JSON. Structured input and special values are tagged:

| Value | Representation |
| --- | --- |
| Undefined | `{"$type":"undefined"}` |
| NaN / infinity | `{"$type":"number","value":"NaN"\|"+Infinity"\|"-Infinity"}` |
| BigInt | `{"$type":"bigint","value":"123"}` |
| Bytes | `{"$type":"bytes","data":"<base64>"}` |
| Array | `{"$type":"array","items":[<values>]}` |
| Plain record | `{"$type":"object","entries":[["key",<value>]]}` |
| Native reference | `{"$type":"ref","id":"1"}` |
| External callback | `{"$type":"callback","id":"cb1"}` |

Tags never conflict with an ordinary record's keys because records are encoded as entries. Object/function returns normally become references, including arrays and plain records; repeated native identities reuse a handle until release. Bytes remain byte values. Handles are scoped to one connection and cannot cross clients. Functions returned as handles can be called with an empty path; member calls preserve their owning receiver.

`snapshot` copies arrays and plain records recursively, preserving native class instances as handles. Cyclic snapshots fail. It does not flatten native VS Code classes or invoke getters beyond enumerated plain-record fields.

JS SDK methods automatically encode/decode values. Remote operations return promises. Native objects are `RemoteRef`, never synchronous proxies pretending to be native VS Code objects.

## Operations

All operation names below are fixed. `target` is `"vscode"`, `"context"` (the native ExtensionContext), or a reference tag. Paths are arrays of property-name strings. Empty paths address the target itself, except for `set`, which requires at least one member.

| Operation | Parameters | Result |
| --- | --- | --- |
| `get` | `{target,path}` | Encoded member value |
| `set` | `{target,path,value}` | Encoded assigned value |
| `call` | `{target,path,args?,owned?}` | Encoded awaited return |
| `construct` | `{target,path,args?,owned?}` | New reference |
| `subscribe` | `{target,path,callback}` | Owned event-disposable reference |
| `unsubscribe` | `{subscription:ref}` | Undefined |
| `loadModule` | `{path}` | Module-export reference |
| `snapshot` | `{target,path?}` | Copied data with native references |
| `release` | `{target:ref}` | Undefined |
| `dispose` | `{target:ref}` | Undefined |

`call` awaits thenables and invokes a member with its original receiver. `construct` uses native construction. A nonexistent member, invalid constructor, or native API error propagates as an RPC error. No special endpoints are needed for status bars, commands, providers, terminals, webviews, diagnostics, file operations, other extension exports, or future available native APIs.

## Callbacks, events and cancellation

External functions are callback tags. Native code invokes them by sending a request in the opposite direction:

```json
{"jsonrpc":"2.0","id":"server-42","method":"callback","params":{"id":"cb1","args":[<encoded arguments>]}}
```

The caller responds with an encoded result or JSON-RPC error. The server decodes the result before returning it to VS Code. These callbacks are asynchronous even if the external implementation finishes immediately. Providers whose APIs accept thenables can use them. APIs requiring synchronous callbacks must use a workspace module.

An event subscription sends callback requests using the same mechanism. Its returned disposable is owned automatically. Unsubscribing disposes only that subscription. Event callback failures cannot become synchronous native event exceptions.

Cancellation is a notification `{"jsonrpc":"2.0","method":"$/cancelRequest","params":{"id":"request id"}}`. Cancelled operations reject promptly with code `-32800`. A native promise may not support cancellation; a newly owned late result is still disposed. An in-flight module activation receives cancellation immediately through its context signal. Native CancellationToken arguments remain accessible as handles/events; they are not silently converted to external AbortSignals.

The JS SDK accepts `{signal}` as each operation's second argument. Inside external callbacks its `callbackContext.signal` exposes bridge request/disconnect cancellation without adding arguments to native callback signatures. Cancellation is cooperative for external callback code.

Errors use JSON-RPC parse/invalid-request/method/params codes `-32700/-32600/-32601/-32602`; authentication `-32001`, trust `-32002`, disconnect `-32010`, cancellation `-32800`, and otherwise `-32000` or a native numeric code. Messages and optional data propagate. A bridge cannot roll back native effects already completed before cancellation.

## Workspace modules

`loadModule` accepts a relative or absolute path whose real filesystem path resolves inside the selected workspace. Symlink escapes are rejected. Modules export `activate(context)`, returning callable exports (object or function), optionally a promise. When no exports are returned, the module namespace is exposed. Module context contains:

- `vscode`: the full native API, with synchronous semantics.
- `extensionContext`: the native bridge extension context.
- `workspaceFolder`: the selected native workspace folder.
- `signal`: an AbortSignal for activation cancellation, unloading, and disconnect.
- `subscriptions`: connection-owned disposables; new subscriptions after cancellation are disposed.
- `asAbsolutePath(relative)`: resolve a path within the workspace.

Example `tools/editor-module.cjs`:

```js
exports.activate = ({ vscode }) => ({
  async replace(uri, text) {
    const document = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(document);
    return editor.edit(builder => builder.replace(
      new vscode.Range(0, 0, document.lineCount, 0), text
    ));
  }
});
```

An external program calls `loadModule({path:"tools/editor-module.cjs"})`, then `call({target:module,path:["replace"],args:[uri,text]})`.

Unload by disposing the module reference. Unload/disconnect aborts the signal, disposes subscriptions and returned disposable exports, and invokes optional `deactivate()` once for each activation. Activation failure/cancellation performs the same cleanup, including late resources. Module source uses Node's native loader/cache: unloading releases activation resources, not Node's shared import cache. Stateful modules should put per-activation state inside `activate`.

CommonJS/ESM are supported by the host runtime. TypeScript support follows that runtime's native type stripping or workspace transpilation setup; synchronous module behavior itself always runs inside VS Code.

## Ownership and disconnect

Set `owned:true` on a call/constructor returning a new disposable to transfer cleanup to the connection. Existing borrowed resources are not owned unless explicitly requested. Disconnect disposes owned resources, event subscriptions, and modules, aborts pending work, and invalidates handles/callbacks. It never automatically disposes borrowed user resources.

`release` only drops a reference; it does not dispose a native resource. An owned resource remains owned until explicit disposal/disconnect even after release. `dispose` explicitly invokes the resource's disposer and invalidates its handle. There is no whole-connection `dispose` RPC: close the WebSocket.

The bridge grants trusted callers full extension privileges and is not a security boundary between workspace programs. The native API and third-party extensions may have additional availability, consent, or environment requirements.

## Compatibility tests

`npm test` exercises fixed message shapes and lifecycle invariants. `npm run test:vscode` verifies native behavior from real external Node, Python, and Luau programs. When adding a workspace feature, demonstrate it through these existing operations; do not extend the bridge protocol.
