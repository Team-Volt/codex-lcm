# Architecture

## Flow

1. Codex invokes a lifecycle hook command.
2. `codex-lcm hook <event>` reads stdin as JSON.
3. The payload is normalized into a stable event schema.
4. Obvious secrets and oversized content are sanitized.
5. The sanitized event is appended to `events.jsonl`.
6. SQLite indexing is attempted. This builds session rows, FTS rows, extractive
   summaries, file references, and a derived DAG. Index failure does not undo or block raw append.
7. `codex-lcm mcp` serves health, stats, search, summary, retrieval, diagnostics, note, and context-packing tools over stdio JSON-RPC.

## Plugin Packaging

Codex LCM is packaged as a native Codex plugin. The manifest at
`.codex-plugin/plugin.json` declares:

- `mcpServers`: points to `.mcp.json`, which starts `node ./bin/codex-lcm mcp`.
- `hooks`: points to `hooks/hooks.codex.json`, which registers the lifecycle hooks.
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
- `session_summaries`
- `session_summary_fts`
- `summary_nodes`
- `summary_node_fts`
- `file_refs`
- `graph_nodes`
- `graph_edges`

Codex LCM creates the index opportunistically during ingestion. If indexing is unavailable, raw-log fallback scans keep health, session lookup, retrieval, and basic search usable.

`file_refs` records large path-backed outputs detected in sanitized event
payloads. Each row stores the path, source event, byte count, SHA-256, MIME
guess, and a compact exploration summary. It is metadata for inspection and
search triage, not a second copy of the full file.

## Summary Index

Session summaries are deterministic and extractive. They are rebuilt from
sanitized raw events whenever a session is indexed, so they can be deleted and
recreated without changing the source data.

Each summary records:

- title
- overview
- topics
- key user prompts and notes
- assistant outcomes from `Stop` plus compaction signals from `PreCompact` and `PostCompact`
- source event IDs

`session_summary_fts` lets broad topic queries match these compact clues before
the caller loads raw events. `lcm_get_session_summary` exposes a summary
directly.

`summary_nodes` stores a multi-depth summary DAG. D0 nodes summarize bounded
chunks of high-signal source events. D1 and deeper nodes summarize lower-depth
summary nodes. Each node stores depth, source type, source IDs, source event IDs,
topic terms, token estimates, and a deterministic node ID derived from its
lineage. `summary_node_fts` indexes the node text and topics.

The standard retrieval flow is deliberately small:

1. `lcm_grep` finds likely sessions by searching summary nodes, session
   summaries, and high-signal raw events.
2. `lcm_describe` inspects a session or summary node without loading a full
   transcript.
3. `lcm_expand` expands one selected summary node into bounded source summary
   nodes and source events.

`lcm_expand_query` is the query-first expansion path. It searches matching
summary nodes, recursively follows summary-node source lineage, and returns
focused source events plus summary-node evidence under a caller-supplied token
budget. By default it keeps direct query matches competitive; with
`overview: true`, it favors higher-depth, source-rich summary nodes for broad
lineage views. `sourceLimit` bounds source events or source summary nodes per
matched node/source expansion, not total returned evidence.

`lcm_pack_context` uses the same underlying summary-node lineage, but packages
the result as model-ready Markdown. It searches summary nodes first, ranks
direct lower-depth hits ahead of broad higher-depth hits, and expands only the
selected source lineage. For tight budgets it uses a compact summary-node form
so the matched source text is not crowded out by metadata. Raw events remain
available through `lcm_get_session`.

Summary rebuilds are bounded for long sessions. Storage reads early high-signal
events, latest high-signal events, and a short recent tail, then deduplicates the
sample before extracting topics and outcomes. The summary should capture the
initial task, recent drift, and the latest result without scanning an entire
giant transcript on every hook event.

## DAG Index

The graph index is derived and deterministic. Raw JSONL remains the source of truth.

Node kinds:

- `session`: one per Codex session ID.
- `turn`: one per session/turn ID when hook payloads include `turn_id`.
- `event`: one per stored raw event.
- `checkpoint`: structural checkpoint nodes created on `PreCompact` and every 50 indexed events.
- `summary`: derived summary nodes at D0, D1, and deeper levels.

Edge kinds:

- `contains`: session to turn/event, turn to event.
- `next`: previous event to next event within the same session.
- `tool_result`: matching `PreToolUse` to `PostToolUse` with the same `tool_use_id`.
- `checkpoint`: session to checkpoint.
- `summary_source`: summary node to source event node or lower-depth summary node.

`summary_source` edges are persisted when summary nodes are rebuilt. Older
indexes without persisted summary-source rows still get a synthesized fallback
when graph slices are read. Unknown edge kinds run a recursive reachability
check from the prospective child to the prospective parent. Known internal edge
kinds (`contains`, `next`, `tool_result`, `checkpoint`, and `summary_source`)
skip that expensive check because they are derived from append-only session
order or summary-source lineage.

For very long sessions, callers should prefer bounded graph and event access:

- `lcm_grep`, `lcm_describe`, and `lcm_expand` for discovery and source-backed expansion.
- `lcm_expand_query` for focused recursive evidence expansion without manually choosing a node first.
- `lcm_get_session` with `limit` and `cursor`.
- `lcm_get_session_graph` with a bounded `limit`.
- `lcm_context_plan` to decide whether summary-node packing is likely useful before continuing a long session.
- `lcm_pack_context`, which searches summary nodes first and expands bounded source lineage.

`codex-lcm benchmark long-context --json` is the local regression harness for
this path. It creates temporary storage, imports a synthetic long session with
an old marker event, and verifies packed context recovers that source evidence.

Search uses strict SQLite FTS first against summary nodes, session summaries,
and events. If a non-empty query has no strict hits, LCM builds a relaxed query
from signal terms and retries. Summary-node matches receive extra weight because
they represent extracted session substance rather than incidental raw text.
Session search still ranks by query-term coverage before recency, so a newer
shallow hit should not hide an older session with more of the requested
substance. For context packing, cwd remains the first boundary, but an empty
cwd-scoped query falls back to bounded global search before returning an empty
or misleadingly narrow pack.

## MCP Protocol

The server accepts the local Codex plugin newline-delimited JSON-RPC pattern and Content-Length framed JSON-RPC messages over stdio. Responses use newline-delimited JSON by default and mirror Content-Length framing after a framed request.

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
