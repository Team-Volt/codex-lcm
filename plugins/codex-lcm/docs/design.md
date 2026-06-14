# Codex LCM Design

## Goal

Build a fresh Codex-native, session-first lossless context memory plugin. It captures Codex session events through hooks, stores sanitized raw events before indexing, and exposes retrieval through a stdio MCP server. Project and git metadata are recorded when available, but session ID and cwd are the primary anchors.

## Codex Surfaces Verified During Development

- `~/.codex/config.toml` has `features.hooks = true`, `features.memories = true`, `plugins = true`, and existing stdio MCP entries under `[mcp_servers.*]`.
- Native hook manifests use Codex lifecycle names `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `PostCompact`, and `Stop`. The global `~/.codex/hooks.json` file may stay empty when hooks come from installed plugins.
- `codex mcp add --help` supports stdio MCP registration with `codex mcp add <name> -- <command>...`.
- Installed plugins declare `.codex-plugin/plugin.json`, optional `.mcp.json`, and optional hook manifests. Codex injects `${PLUGIN_ROOT}` for plugin hook commands so hooks can resolve the installed plugin root.
- Installed hook scripts read JSON from stdin, tolerate snake_case and camelCase payload fields, and exit cleanly on malformed JSON.
- Node `v22.22.3` can run `.ts` files with type stripping and exposes `node:sqlite`. This implementation uses no runtime npm dependencies.

## Plugin Shape

- `.codex-plugin/plugin.json` declares plugin metadata and points to `.mcp.json` plus `hooks/hooks.codex.json`.
- `.mcp.json` registers a stdio MCP server command: `node ./bin/codex-lcm mcp`.
- `hooks/hooks.codex.json` registers the supported lifecycle events and calls `node "${PLUGIN_ROOT}/bin/codex-lcm" hook <event>`.
- `bin/codex-lcm` is the CLI entrypoint for both plugin use and local development.

## Data Model

Storage defaults to `~/.codex-lcm` and can be overridden with `CODEX_LCM_HOME`.

- `events.jsonl`: append-only sanitized raw event log. This is written first and must succeed even if SQLite indexing fails.
- `index.sqlite`: derived index with `sessions`, `events`, `event_fts`, `session_summaries`, `session_summary_fts`, `summary_nodes`, `summary_node_fts`, `graph_nodes`, and `graph_edges`.
- Events include schema version, event ID, timestamp, hook event, session ID, cwd, optional repo root, optional git branch, sanitized payload, redaction metadata, truncation metadata, and a SHA-256 hash of the original stdin.

Raw event capture is lossless for retained sanitized payloads. Privacy and safety controls run before persistence: obvious secrets are redacted, oversized strings/objects are truncated with hashes and byte counts, and binary/image-like blobs are replaced with metadata.

The DAG layer is deterministic and rebuildable from indexed raw events:

- Session nodes anchor session IDs.
- Turn nodes group events with the same `turn_id`.
- Event nodes reference raw event IDs.
- Checkpoint nodes summarize structure at `PreCompact` and every 50 indexed events.
- Summary nodes summarize high-signal event chunks and lower-depth summary nodes.
- Edges are typed as `contains`, `next`, `tool_result`, `checkpoint`, or `summary_source`.

Edge insertion rejects self-edges and recursive back edges, so the derived graph remains acyclic. Graph failures are treated as index failures; the raw JSONL event has already been written and remains recoverable.

The summary layer is also deterministic and rebuildable. It extracts compact
session-level clues from high-signal events: user prompts, notes, stop messages,
pre-compaction checkpoints, and post-compaction messages that include a `summary`
or `reason`. Session summaries store title, overview, topics, key
prompts, outcomes, and source event IDs. Summary nodes form a multi-depth DAG:
D0 nodes summarize bounded high-signal event chunks, and D1+ nodes summarize
lower-depth summary nodes. No LLM, embeddings, or network calls are required.
The job is ranking and context packing; raw events stay the evidence layer.
Codex-generated suggestion prompts and their JSON suggestion responses remain
raw events, but they are skipped by summaries and summary nodes so broad search
does not confuse generated next-step ideas with user-directed work.

For long sessions, the session-summary builder samples early high-signal events,
latest high-signal events, and recent events. Summary nodes are chunked and
fanned out into deeper nodes so retrieval can search compact text and expand the
matched lineage instead of scanning or packing an entire long transcript.

## Hook Behavior

`codex-lcm hook <event>` reads JSON from stdin and normalizes it. It accepts common Codex hook keys in snake_case or camelCase, including `session_id`, `sessionId`, `cwd`, `tool_name`, `toolName`, `tool_input`, `toolArgs`, `tool_output`, `tool_response`, `prompt`, and `userPrompt`. For compaction, `PreCompact` remains the structural checkpoint and `PostCompact` records the completion marker plus any compacted summary payload Codex provides.

The hook path is synchronous only long enough to sanitize, append JSONL, and attempt local indexing. Index failures are swallowed after a diagnostic line to stderr so Codex turns are not blocked by the indexer.

## MCP Tools

- `lcm_health`: report storage paths, index status, event count, session count, summary-node count, and current configuration.
- `lcm_stats`: report aggregate index shape, hook-event counts, summary nodes by depth, graph node and edge counts, freshness timestamps, max summary depth, and sessions with summary nodes without returning raw transcript text.
- `lcm_grep`: standard discovery entry point. It searches summary nodes, session summaries, and high-signal raw events, then returns session-level matches with best-match and discovery metadata.
- `lcm_describe`: inspect a session or summary node before loading raw content. Session descriptions include the deterministic summary and bounded summary-node list; node descriptions include depth and source lineage metadata.
- `lcm_expand`: expand a selected summary node into bounded source summary nodes and high-signal source events. This is deterministic evidence expansion, not agent-driven answer synthesis.
- `lcm_current_session`: locate the current or latest known session by session ID, cwd, or repo root.
- `lcm_search_sessions`: cross-session discovery using SQLite FTS. Results
  include a compact `best_match` clue and source kind, support recent-session
  fallback for empty queries, use relaxed broad-query retry when strict FTS has
  no hits, include `discovery` confidence metadata for ranking quality, and
  accept current-session exclusion options for prior-history searches.
- `lcm_get_session`: retrieve a session by ID with sanitized raw events; supports `limit` and `cursor` for long sessions.
- `lcm_get_session_summary`: retrieve the deterministic extractive summary for a session, including topics and source event pointers.
- `lcm_get_session_graph`: retrieve a bounded DAG slice for a session, including summary nodes when present.
- `lcm_get_recent_context`: retrieve recent events for a session or latest cwd-matching session.
- `lcm_pack_context`: pack matching summary nodes and bounded source lineage into a token-budgeted Markdown context block. A cwd-scoped pack falls back to bounded global search when scoped retrieval is empty.
- `lcm_record_note`: append a user-authored note as a first-class event and index it.

The standard agent path is `lcm_grep` -> `lcm_describe` -> `lcm_expand`.
`lcm_pack_context` remains the Codex-specific shortcut when the caller wants a
ready-to-use context block. The plugin does not expose `lcm_expand_query`
because the MCP server does not spawn a reasoning agent; callers should expand
evidence and answer in the host model.

The plugin also provides `skills/lcm-recall/SKILL.md`. That skill tells Codex when to call LCM and how to avoid loading entire long sessions unnecessarily.

## Install Policy

Native Codex plugin installation is the primary path. The plugin manifest
declares the MCP server, hook manifest, and `skills/` directory, so
`codex plugin add codex-lcm@codex-lcm` is enough to install the runtime pieces
that Codex owns.

The CLI also provides explicit dry-run wiring helpers for development,
diagnostics, and manual or older setups:

- `codex-lcm install --dry-run` prints the `codex mcp add` command and the hook entries that would be merged into `~/.codex/hooks.json`.
- `codex-lcm status` reads current Codex config/hooks and reports whether MCP and hook wiring appear present.
- `codex-lcm uninstall --dry-run` prints the `codex mcp remove` command and hook commands that would be removed.

The dry-run helpers are not required after native plugin installation and do not
copy skills. There is currently no non-dry-run apply path; the implementation
must not edit `~/.codex/config.toml` or `~/.codex/hooks.json` itself.

## Limits

- First version is local only and requires no external APIs.
- Embeddings are deferred; FTS plus deterministic summaries are the first search backend.
- If SQLite indexing is unavailable, raw JSONL append still works and retrieval falls back to scanning `events.jsonl`; graph retrieval returns a bounded fallback graph from raw events when possible.
- Hook payload shape is based on verified local installed hook examples and tolerant parsing. Unknown future Codex fields are preserved inside the sanitized payload.
- Unit and smoke tests use synthetic hook events and direct MCP stdio calls.
  Native hook dispatch was additionally verified through the local Codex TUI
  trust flow during installation.
