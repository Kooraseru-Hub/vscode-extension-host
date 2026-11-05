# Kooraseru Extension Host

A product-neutral VS Code extension host for plugins that need workspace lifecycle events and live diagnostics. It has no language, linter, build system, or project-layout assumptions.

![Extension icon](images/icon.png)

## Plugin API

Plugins declare `kooraseru-hub.vscode-extension-host` in `extensionDependencies`, activate the host extension, then register diagnostic providers through its exported API. See [`docs/plugin-contract.md`](docs/plugin-contract.md) for the contract and examples.

Providers are rerun after document opens, edits, saves, workspace file changes, and configuration changes. Each run receives snapshots of open documents, including unsaved content. Results are replaced per provider and workspace so stale diagnostics clear when a check passes or a provider is disposed. Providers can return diagnostics or `{ diagnostics, ...resultData }` for a caller that needs the run result.

The host reports diagnostics only. It does not modify documents, run formatters, reveal terminals, execute checkers, or interpret rule files. Plugins own those decisions.

## Development

- Node.js 20 or newer
- `npm install`
- `npm test`
- `npm run package:vsix`

Distributed under the ISC License. Copyright (c) 2026 Kooraseru.
