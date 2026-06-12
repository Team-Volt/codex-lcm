# Troubleshooting

## Check Local Status

```sh
node bin/codex-lcm status --json
```

This reads Codex config and hooks from `~/.codex` by default. Use `--codex-home <path>` for tests.

## MCP Does Not Appear In Codex

For plugin installs, first check the marketplace and plugin entry:

```sh
codex plugin marketplace list
codex plugin list
```

Native plugin install should expose the MCP server through `.mcp.json`. The
manual planner is only for development, diagnostics, or older/manual setups
where you want to inspect equivalent wiring:

```sh
node bin/codex-lcm install --dry-run
codex mcp list
```

If you already have an MCP server named `lcm`, it can coexist with this plugin because this server is named `codex-lcm`.

## Hooks Are Not Capturing

After plugin install, the Codex TUI asks you to review and trust hooks. Choose review, confirm the `codex-lcm` hook commands, then trust them. If you continue without trusting, hooks will not run for that session.

Check the hook entries:

```sh
node bin/codex-lcm install --dry-run --json
```

The dry run prints commands for `SessionStart`, `UserPromptSubmit`,
`PreToolUse`, `PostToolUse`, `PreCompact`, and `Stop`. This tool is not needed
after native plugin installation and does not edit `~/.codex/hooks.json`
automatically.

For native plugin installs, Codex discovers hooks through `.codex-plugin/plugin.json`:

```json
"hooks": "./hooks/hooks.codex.json"
```

Some plugin validation tools may lag the live Codex plugin schema and complain
about the `hooks` field. The live Codex CLI/TUI uses this field for plugin-owned
hook discovery. If hooks do not prompt for review after install, verify that the
field is still present.

## Skill Does Not Appear

Native plugin installation loads skills from:

```json
"skills": "./skills/"
```

The installed skill is `lcm-recall`. The `codex-lcm install --dry-run` command
does not copy or install skills; it only reports where the skill lives in the
plugin package.

## Storage Problems

Use a temporary home to isolate issues:

```sh
CODEX_LCM_HOME=/private/tmp/codex-lcm-check node bin/codex-lcm hook UserPromptSubmit
CODEX_LCM_HOME=/private/tmp/codex-lcm-check node bin/codex-lcm health --json
```

If SQLite cannot open `index.sqlite`, Codex LCM still appends `events.jsonl` and falls back to raw-log scanning.

## Node Warnings

The implementation uses Node 22's `node:sqlite`. Test and smoke scripts run with `--no-warnings` so experimental runtime warnings do not interfere with MCP stdout parsing.

## Plugin Validation And Tests

The plugin-creator validator may require Python dependencies such as PyYAML. If
it is unavailable, validate the JSON files directly and run:

```sh
npm test
npm run smoke
npm --cache /tmp/codex-lcm-npm-cache pack --dry-run
```
