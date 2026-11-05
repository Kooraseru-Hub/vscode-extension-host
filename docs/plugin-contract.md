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

## Workspace command protocol

For a trusted workspace, `vscodeExtensionHost.diagnosticsCommand` can name an executable followed by its arguments. The host launches it without a shell or terminal, with the workspace root as its working directory. It writes one JSON request to stdin and closes the stream. The request contains `workspaceRoot`, `reason`, `documents`, and optional `changedDocument` and `changedFile`. Document entries include workspace-relative `path`, current `text`, `languageId`, `version`, and `isDirty`; this includes unsaved edits. A file event contains `path` and `kind`.

The command writes a single JSON object `{ "diagnostics": [...] }` to stdout and exits successfully. Diagnostics use the same record shape documented below. The command must return the complete current result for its workspace: the host replaces the previous result after each run. A failure or invalid response is reported as a provider failure. The host aborts superseded commands and discards stale results. The command is responsible for checking unopened files and for remaining report-only.

- `apiVersion`: integer identifying the host API contract (`1` initially).
- `getWorkspaceFolders()`: returns the current VS Code workspace folders.
- `onDidChangeWorkspaceFolders(listener)`: subscribe to workspace additions/removals; returns a disposable.
- `registerDiagnosticProvider({ id, provideDiagnostics, provideCodeActions?, matchesDocument?, matchesFile? })`: register one provider. IDs must be unique while registered. Returns `{ refresh(folder, options?), dispose() }`. A provider may return VS Code `CodeAction` items from `provideCodeActions` for explicit user invocation.
- `refreshDiagnostics(id, folder, options?)`: run a registered provider immediately.

Providers receive `{ workspaceFolder, workspaceRoot, documents, changedDocument, changedFile, reason, signal, options }`. A document snapshot contains `{ uri, path, text, languageId, version, isDirty }`. A file event snapshot contains `{ uri, path, kind }`, where `kind` is `created`, `changed`, or `deleted`. Both paths are workspace-relative with `/` separators for file resources. Providers run on every workspace file event by default. `matchesDocument(document)` can scope editor events, and `matchesFile(fileEvent, workspaceFolder)` can scope workspace file events; an initial run still occurs so providers can populate diagnostics when activated. Provider results are either an array of standard diagnostic records or `{ diagnostics, ...providerData }`. Each record may contain `path`, 1-based `line` and `column`, `severity`, `code`, `source`, and required `message`.

Relative diagnostic paths are resolved against the workspace root. Findings that escape the workspace are ignored. Diagnostic records may include 1-based `endLine` and `endColumn` to underline a token or full source span; otherwise the host highlights a one-character range. Provider exceptions become a `provider-failed` diagnostic. Each result atomically replaces the provider's prior diagnostics for that workspace; disposing the registration clears them. Providers should honor the supplied `AbortSignal`; the host also discards stale results from providers that do not.

The host debounces ordinary editor events. Manual refresh bypasses the debounce and passes caller options to the provider. The host never applies edits automatically; it may expose provider-supplied Quick Fix actions for the user to invoke.

## Workspace setup

Trusted workspaces may configure `vscodeExtensionHost.workspaceSetupScript` with a JavaScript file path relative to the workspace. The host runs that script silently at startup using VS Code's Node runtime, with its working directory set to the workspace root. Output and failures are recorded in the **Kooraseru Workspace Setup** output channel; no terminal is opened. Symlinks that resolve outside the workspace are rejected.

Optional `vscodeExtensionHost.workspaceSetupWatch` entries are workspace-relative file patterns. Changes to those files or the setup script schedule another run. Runs for the same workspace do not overlap. Setup is skipped in untrusted workspaces and starts when trust is granted.
