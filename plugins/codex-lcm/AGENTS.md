# Codex LCM package

This directory is the publishable Codex plugin package. Keep package changes
focused on the native plugin, its command entry point, and the files shipped
with the package. Repository-wide release, marketplace, and navigation rules
live in the parent `AGENTS.md`.

## Package boundary

- Run all package commands from `plugins/codex-lcm`.
- Treat `README.md`, `package.json`, and the package source as the package
  contract; update documentation when a public command or install behavior
  changes.
- Keep the package dependency-free at runtime. Do not add a production npm
  dependency when Node's standard library or existing code is enough.
- Node 22.18 or newer is required. CI currently exercises Node 22.22.3.

## Native install surface

These files form one install contract and must stay aligned:

- `.codex-plugin/plugin.json` declares the plugin, skill directory, MCP file,
  and hook file.
- `.mcp.json` starts the local stdio server with `node ./bin/codex-lcm mcp`.
- `hooks/hooks.codex.json` routes supported lifecycle events through the
  package entry point and `${PLUGIN_ROOT}`.
- `skills/` contains the bundled `lcm-recall` skill.

When changing any manifest path, command, hook event, or package metadata,
update `tests/plugin-manifest.test.ts` in the same change. Keep hook commands
portable and rooted at `${PLUGIN_ROOT}`; do not hard-code a checkout path or a
different plugin variable.

## TypeScript and modules

- The package uses native ESM (`"type": "module"`).
- Source files are TypeScript executed directly by the supported Node test and
  command paths; preserve explicit `.ts` specifiers for local modules, as
  enabled by `allowImportingTsExtensions` in `tsconfig.json`.
- Use Node built-ins and the existing package patterns before introducing a
  helper or dependency.
- Keep `bin/codex-lcm` as the thin command boundary; put behavior in `src/`.

## Commands

```sh
npm run typecheck
npm test
npm run smoke
npm pack --dry-run
```

Use a temporary `CODEX_LCM_HOME` for local capture, import, or retrieval
checks. `npm pack --dry-run` may use a temporary npm cache when the global
cache is not writable.

## Package anti-patterns

- Do not add a second installer or separate CLI install step; native plugin
  installation owns MCP, hooks, and skills.
- Do not duplicate hook or MCP inventories in contributor docs; manifests and
  their contract test are the source of truth.
- Do not add a runtime framework, bundler, or root-level package manifest for
  this single nested package.
- Do not write generated indexes, smoke-test state, or user data into the
  repository. Keep raw storage and temporary checks outside the checkout.
