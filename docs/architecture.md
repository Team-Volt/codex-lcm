# Architecture

## Flow

1. Codex invokes a lifecycle hook command.
2. `codex-lcm hook <event>` reads stdin as JSON.
3. The payload is normalized into a stable event schema.
4. Obvious secrets and oversized content are sanitized.
5. The sanitized event is appended to `events.jsonl`.
6. SQLite indexing is attempted. Index failure does not undo or block raw append.
7. `codex-lcm mcp` serves health, search, retrieval, note, and context-packing tools over newline-delimited JSON-RPC.

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

The first version creates the index opportunistically during ingestion. If indexing is unavailable, raw-log fallback scans keep health, session lookup, retrieval, and basic search usable.

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
