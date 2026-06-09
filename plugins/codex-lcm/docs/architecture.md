# Architecture

## Flow

1. Codex invokes a lifecycle hook command.
2. `codex-lcm hook <event>` reads stdin as JSON.
3. The payload is normalized into a stable event schema.
4. Obvious secrets and oversized content are sanitized.
5. The sanitized event is appended to `events.jsonl`.
6. SQLite indexing is attempted. This builds session rows, FTS rows, and a derived DAG. Index failure does not undo or block raw append.
7. `codex-lcm mcp` serves health, search, retrieval, note, and context-packing tools over newline-delimited JSON-RPC.

## Plugin Packaging

Codex LCM is packaged as a native Codex plugin. The manifest at
`.codex-plugin/plugin.json` declares:

- `mcpServers`: points to `.mcp.json`, which starts `node ./bin/codex-lcm mcp`.
- `hooks`: points to `hooks/hooks.codex.json`, which registers the six lifecycle hooks.
- `skills`: points to `skills/`, which exposes `lcm-recall`.

After `codex plugin add codex-lcm@codex-lcm`, these plugin-owned resources are
the active install surface. The `codex-lcm install --dry-run` command is not
part of native plugin installation; it only prints an equivalent manual wiring
plan for development or compatibility checks.

## Event Schema

Every stored event includes:

- `schema_version`
- `event_id`
- `timestamp`
- `hook_event`
- `session_id`
- `cwd`
- optional `project`
- optional `repo_root`
- optional `git_branch`
- optional `tool_name`
- sanitized `payload`
- `redactions`
- `truncations`
- `raw_input_sha256`
- byte counts

Unknown payload fields are preserved inside `payload` after sanitization.

## Storage

Default home:

```text
~/.codex-lcm/
  events.jsonl
  index.sqlite
```

`events.jsonl` is the source of truth. `index.sqlite` is derived and can be deleted or rebuilt later.

SQLite tables:

- `sessions`
- `events`
- `event_fts`
- `graph_nodes`
- `graph_edges`

The first version creates the index opportunistically during ingestion. If indexing is unavailable, raw-log fallback scans keep health, session lookup, retrieval, and basic search usable.

## DAG Index

The graph index is derived and deterministic. Raw JSONL remains the source of truth.

Node kinds:

- `session`: one per Codex session ID.
- `turn`: one per session/turn ID when hook payloads include `turn_id`.
- `event`: one per stored raw event.
- `checkpoint`: structural checkpoint nodes created on `PreCompact` and every 50 indexed events.

Edge kinds:

- `contains`: session to turn/event, turn to event.
- `next`: previous event to next event within the same session.
- `tool_result`: matching `PreToolUse` to `PostToolUse` with the same `tool_use_id`.
- `checkpoint`: session to checkpoint.

Before inserting an edge, storage runs a recursive reachability check from the prospective child to the prospective parent. If the parent is already reachable from the child, the edge is rejected because it would create a cycle.

For very long sessions, callers should prefer bounded graph and event access:

- `lcm_get_session` with `limit` and `cursor`.
- `lcm_get_session_graph` with a bounded `limit`.
- `lcm_pack_context`, which searches matching events first, then adds nearby graph context, checkpoints, and recent tails.

## MCP Protocol

The server follows the local Codex plugin pattern verified in the installed OpenAI Developers plugin: one JSON-RPC message per line over stdio.

Implemented methods:

- `initialize`
- `ping`
- `tools/list`
- `tools/call`

## Hook Compatibility

The normalizer accepts both snake_case and camelCase fields observed in installed local hook scripts:

- `session_id` / `sessionId`
- `tool_name` / `toolName`
- `tool_input` / `toolArgs`
- `tool_output`, `tool_response`, `tool_result`, `toolResult`
- `prompt` / `userPrompt`

Malformed JSON is stored as a parse-error event with a redacted raw preview.
