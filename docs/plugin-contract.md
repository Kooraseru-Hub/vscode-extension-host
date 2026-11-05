# Plugin Contract

The host is a VS Code extension that exports a small API from `activate()`. A plugin declares the host extension id in `extensionDependencies`; VS Code activates dependencies before the dependent extension. Both extensions must run in the same extension host.

```js
const hostExtension = vscode.extensions.getExtension("kooraseru-hub.vscode-extension-host");
const host = hostExtension.isActive ? hostExtension.exports : await hostExtension.activate();

const diagnostics = host.registerDiagnosticProvider({
	id: "example.rules",
	 async provideDiagnostics(context) {
		 // context.documents contains current open-buffer text, including unsaved edits.
		 return { diagnostics: [] };
	 },
});
context.subscriptions.push(diagnostics);
```

## API

- `apiVersion`: integer identifying the host API contract (`1` initially).
- `getWorkspaceFolders()`: returns the current VS Code workspace folders.
- `onDidChangeWorkspaceFolders(listener)`: subscribe to workspace additions/removals; returns a disposable.
- `registerDiagnosticProvider({ id, provideDiagnostics, matchesDocument? })`: register one provider. IDs must be unique while registered. Returns `{ refresh(folder, options?), dispose() }`.
- `refreshDiagnostics(id, folder, options?)`: run a registered provider immediately.

Providers receive `{ workspaceFolder, workspaceRoot, documents, changedDocument, reason, signal, options }`. A document snapshot contains `{ uri, path, text, languageId, version, isDirty }`. `path` is workspace-relative with `/` separators for file documents. Provider results are either an array of standard diagnostic records or `{ diagnostics, ...providerData }`. Each record may contain `path`, 1-based `line` and `column`, `severity`, `code`, `source`, and required `message`.

Relative diagnostic paths are resolved against the workspace root. Findings that escape the workspace are ignored. Provider exceptions become a `provider-failed` diagnostic. Each result atomically replaces the provider's prior diagnostics for that workspace; disposing the registration clears them. Providers should honor the supplied `AbortSignal`; the host also discards stale results from providers that do not.

The host debounces ordinary editor events. Manual refresh bypasses the debounce and passes caller options to the provider. The host never applies edits or fixes.

## Workspace setup

Trusted workspaces may configure `vscodeExtensionHost.workspaceSetupScript` as a workspace-relative JavaScript file and `vscodeExtensionHost.workspaceSetupWatch` as relative watch patterns. The host runs the script silently on activation and after watched changes, using VS Code's Node runtime. Output and errors appear in the Kooraseru Workspace Setup output channel. Runs for one workspace do not overlap.
