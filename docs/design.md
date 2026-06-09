# Codex LCM Design

## Goal

Build a fresh Codex-native, session-first lossless context memory plugin. It captures Codex session events through hooks, stores sanitized raw events before indexing, and exposes retrieval through a stdio MCP server. Project and git metadata are recorded when available, but session ID and cwd are the primary anchors.

## Verified Local Codex Surfaces

- `~/.codex/config.toml` has `features.hooks = true`, `features.memories = true`, `plugins = true`, and existing stdio MCP entries under `[mcp_servers.*]`.
- `~/.codex/hooks.json` uses Codex lifecycle names `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, and `Stop`.
- `codex mcp add --help` supports stdio MCP registration with `codex mcp add <name> -- <command>...`.
- Installed plugins declare `.codex-plugin/plugin.json`, optional `.mcp.json`, and optional hook manifests. The installed AgentMemory Codex hook manifest uses `${CLAUDE_PLUGIN_ROOT}` in command paths.
- Installed hook scripts read JSON from stdin, tolerate snake_case and camelCase payload fields, and exit cleanly on malformed JSON.
- Node is `v22.22.3`, can run `.ts` files with type stripping, and exposes `node:sqlite`. This implementation uses no runtime npm dependencies.

## Plugin Shape

- `.codex-plugin/plugin.json` declares plugin metadata and points to `.mcp.json` plus `hooks/hooks.codex.json`.
- `.mcp.json` registers a stdio MCP server command: `node ./bin/codex-lcm mcp`.
- `hooks/hooks.codex.json` registers the six requested lifecycle events and calls `node "${CLAUDE_PLUGIN_ROOT}/bin/codex-lcm" hook <event>`.
- `bin/codex-lcm` is the CLI entrypoint for both plugin use and local development.

## Data Model

Storage defaults to `~/.codex-lcm` and can be overridden with `CODEX_LCM_HOME`.

- `events.jsonl`: append-only sanitized raw event log. This is written first and must succeed even if SQLite indexing fails.
- `index.sqlite`: derived index with `sessions`, `events`, `notes`, and FTS search tables.
- Events include schema version, event ID, timestamp, hook event, session ID, cwd, optional repo root, optional git branch, sanitized payload, redaction metadata, truncation metadata, and a SHA-256 hash of the original stdin.

Raw event capture is lossless for retained sanitized payloads. Privacy and safety controls run before persistence: obvious secrets are redacted, oversized strings/objects are truncated with hashes and byte counts, and binary/image-like blobs are replaced with metadata.

## Hook Behavior

`codex-lcm hook <event>` reads JSON from stdin and normalizes it. It accepts common Codex/Claude-style keys such as `session_id`, `sessionId`, `cwd`, `tool_name`, `toolName`, `tool_input`, `toolArgs`, `tool_output`, `tool_response`, `prompt`, and `userPrompt`.

The hook path is synchronous only long enough to sanitize, append JSONL, and attempt local indexing. Index failures are swallowed after a diagnostic line to stderr so Codex turns are not blocked by the indexer.

## MCP Tools

- `lcm_health`: report storage paths, index status, event count, session count, and current configuration.
- `lcm_current_session`: locate the current or latest known session by session ID, cwd, or repo root.
- `lcm_search_sessions`: cross-session search using SQLite FTS, with recent-session fallback for empty queries.
- `lcm_get_session`: retrieve a session by ID with sanitized raw events.
- `lcm_get_recent_context`: retrieve recent events for a session or latest cwd-matching session.
- `lcm_pack_context`: pack search results, notes, and recent events into a token-budgeted Markdown context block.
- `lcm_record_note`: append a user-authored note as a first-class event and index it.

## Install Policy

The plugin repository contains plugin-native MCP and hook manifests, but the CLI also provides explicit wiring helpers:

- `codex-lcm install --dry-run` prints the `codex mcp add` command and the hook entries that would be merged into `~/.codex/hooks.json`.
- `codex-lcm status` reads current Codex config/hooks and reports whether MCP and hook wiring appear present.
- `codex-lcm uninstall --dry-run` prints the `codex mcp remove` command and hook commands that would be removed.

The implementation must not edit `~/.codex/config.toml` or `~/.codex/hooks.json` unless the user explicitly chooses a non-dry-run apply path.

## Limits

- First version is local only and requires no external APIs.
- Embeddings are deferred; FTS is the first search backend.
- If SQLite indexing is unavailable, raw JSONL append still works and retrieval falls back to scanning `events.jsonl`.
- Hook payload shape is based on verified local installed hook examples and tolerant parsing. Unknown future Codex fields are preserved inside the sanitized payload.
- Actual Codex Desktop hook dispatch is not assumed by tests; smoke tests use synthetic hook events and direct MCP stdio calls.
