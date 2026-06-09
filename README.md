# Codex LCM

Codex LCM is a fresh Codex-native lossless context memory plugin. It does not depend on the existing `lcm` tool. It captures sanitized raw Codex hook events, appends them to JSONL first, builds a local SQLite FTS index, and exposes retrieval through MCP.

## Requirements

- Node.js 22.18 or newer.
- Codex CLI/Desktop with MCP and hooks enabled.
- No runtime npm dependencies and no external APIs.

Verified on this machine with Node `v22.22.3`, Codex plugin manifests using `.codex-plugin/plugin.json`, stdio MCP entries, and hook payloads read as JSON from stdin.

## Commands

```sh
node bin/codex-lcm --help
node bin/codex-lcm mcp
node bin/codex-lcm hook UserPromptSubmit
node bin/codex-lcm install --dry-run
node bin/codex-lcm status
node bin/codex-lcm health
node bin/codex-lcm uninstall --dry-run
```

Storage defaults to `~/.codex-lcm`. Override storage for hook and MCP operations with:

```sh
CODEX_LCM_HOME=/path/to/lcm-home node bin/codex-lcm health
```

## MCP Tools

- `lcm_health`
- `lcm_current_session`
- `lcm_search_sessions`
- `lcm_get_session`
- `lcm_get_recent_context`
- `lcm_pack_context`
- `lcm_record_note`

## Installing

Dry-run first:

```sh
node bin/codex-lcm install --dry-run
```

The dry run prints the `codex mcp add codex-lcm -- node ".../bin/codex-lcm" mcp` command and the hook entries that would be merged into `~/.codex/hooks.json`.

This tool does not modify `~/.codex/config.toml` or `~/.codex/hooks.json` automatically. Review the dry-run output before applying any wiring yourself.

The repository also includes native Codex plugin files:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `hooks/hooks.codex.json`

## What Is Captured

Hooks capture the JSON payload Codex sends on stdin for:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PreCompact`
- `Stop`

Events store session ID, cwd, optional project string, optional git repo root, optional git branch, hook event name, sanitized payload, redaction metadata, truncation metadata, timestamps, and hashes.

Project and git data are metadata only. Search and retrieval are session-first and work for projectless sessions.

## Privacy And Safety

Before writing to disk, Codex LCM:

- Redacts secret-like keys such as `api_key`, `token`, `password`, `secret`, `authorization`, `cookie`, and `private_key`.
- Redacts obvious token strings such as bearer tokens, `sk-...`, GitHub tokens, Slack tokens, and AWS access key IDs.
- Truncates oversized strings and payloads with SHA-256 hash metadata.
- Stores sanitized raw events before derived indexes or summaries.

If SQLite is unavailable, raw JSONL append still works and retrieval falls back to scanning `events.jsonl`.

## Smoke Test

```sh
npm test
npm run smoke
```

The smoke test uses a temporary `CODEX_LCM_HOME`, sends synthetic hook events, starts the MCP server over stdio, calls search and pack-context tools, and cleans up the temporary directory unless `CODEX_LCM_KEEP_SMOKE=1` is set.

## Known Limitations

- Embeddings are not implemented. Search is SQLite FTS plus raw-log fallback.
- Hook payload compatibility is based on verified local Codex/installed-plugin behavior and tolerant parsing.
- Actual global Codex hook installation is dry-run only in this first version.
- `node:sqlite` is used through Node 22 and should be treated as a local runtime dependency.
