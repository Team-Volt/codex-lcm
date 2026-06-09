# Troubleshooting

## Check Local Status

```sh
node bin/codex-lcm status --json
```

This reads Codex config and hooks from `~/.codex` by default. Use `--codex-home <path>` for tests.

## MCP Does Not Appear In Codex

Run the dry-run command and inspect the printed MCP command:

```sh
node bin/codex-lcm install --dry-run
codex mcp list
```

If you already have an MCP server named `lcm`, it can coexist with this plugin because this server is named `codex-lcm`.

## Hooks Are Not Capturing

Check the hook entries:

```sh
node bin/codex-lcm install --dry-run --json
```

The dry run prints commands for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, and `Stop`. This tool does not edit `~/.codex/hooks.json` automatically.

## Storage Problems

Use a temporary home to isolate issues:

```sh
CODEX_LCM_HOME=/private/tmp/codex-lcm-check node bin/codex-lcm hook UserPromptSubmit
CODEX_LCM_HOME=/private/tmp/codex-lcm-check node bin/codex-lcm health --json
```

If SQLite cannot open `index.sqlite`, Codex LCM still appends `events.jsonl` and falls back to raw-log scanning.

## Node Warnings

The implementation uses Node 22's `node:sqlite`. Test and smoke scripts run with `--no-warnings` so experimental runtime warnings do not interfere with MCP stdout parsing.

## Plugin Validation

The local plugin-creator validator may require Python dependencies such as PyYAML. If it is unavailable, validate the JSON files directly and run:

```sh
npm test
npm run smoke
```
