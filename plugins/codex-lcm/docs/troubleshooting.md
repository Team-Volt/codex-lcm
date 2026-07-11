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
status command reports whether the plugin manifest and MCP manifest are present:

```sh
node bin/codex-lcm status --json
```

If you already have an MCP server named `lcm`, it can coexist with this plugin because this server is named `codex-lcm`.

## Hooks Are Not Capturing

After plugin install, the Codex TUI asks you to review and trust hooks. Choose review, confirm the `codex-lcm` hook commands, then trust them. If you continue without trusting, hooks will not run for that session.

For native plugin installs, Codex discovers hooks through `.codex-plugin/plugin.json`:

```json
"hooks": "./hooks/hooks.codex.json"
```

The hook manifest registers `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PreCompact`, `PostCompact`, `SubagentStop`, and `Stop`.

Some plugin validation tools may lag the live Codex plugin schema and complain
about the `hooks` field. The live Codex CLI/TUI uses this field for plugin-owned
hook discovery. If hooks do not prompt for review after install, verify that the
field is still present.

## Skill Does Not Appear

Native plugin installation loads skills from:

```json
"skills": "./skills/"
```

The installed skills are `lcm-recall` for retrieval and `lcm-memory` for
durable write policy and lifecycle operations.

## Marketplace Upgrade Says It Is Not A Git Marketplace

`codex plugin marketplace upgrade` refreshes configured Git marketplace
snapshots. If your marketplace was added from a local checkout, for example:

```sh
codex plugin marketplace add /path/to/codex-lcm
```

then update the checkout yourself and refresh the installed plugin cache:

```sh
git -C /path/to/codex-lcm pull --ff-only
codex plugin add codex-lcm@codex-lcm
```

After that, restart Codex Desktop or start a fresh Codex CLI/TUI session. The
installed cache path may still contain the same version suffix after a local
refresh, so verify behavior with `codex plugin list`, `codex-lcm stats --json`,
or the `lcm_stats` MCP tool instead of reading the cache directory name.

## Storage Problems

Use a temporary home to isolate issues:

```sh
CODEX_LCM_HOME=/private/tmp/codex-lcm-check node bin/codex-lcm hook UserPromptSubmit
CODEX_LCM_HOME=/private/tmp/codex-lcm-check node bin/codex-lcm health --json
CODEX_LCM_HOME=/private/tmp/codex-lcm-check node bin/codex-lcm stats --json
```

If SQLite cannot open `index.sqlite`, Codex LCM still appends `events.jsonl` and falls back to raw-log scanning.
Durable memory writes are the exception: create, revise, deprecate, and delete
fail with `Durable memory writes require an available index.` so a conflict cannot
append an unprojectable revision. Restore or rebuild `index.sqlite` first; the
existing append-only log remains authoritative.
Use `stats --json` when you need aggregate hook-event, summary-depth,
graph-count, and freshness checks without opening the SQLite database directly.
For compaction hook verification, check `hook_event_counts.PreCompact` and
`hook_event_counts.PostCompact`.
`health` and `stats` open the index read-only. If derived summaries need to be
rebuilt after an upgrade, the next normal hook ingestion or `lcm_record_note`
write will run maintenance.

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
