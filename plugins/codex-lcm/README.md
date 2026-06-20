# Codex LCM

Codex LCM is a Codex-native lossless context memory plugin. It does not depend on the existing `lcm` tool. It captures sanitized raw Codex hook events, appends them to JSONL first, builds local SQLite FTS plus a derived DAG index, and exposes retrieval through MCP.

## Requirements

- Node.js 22.18 or newer.
- Codex CLI/Desktop with MCP and hooks enabled.
- No runtime npm dependencies and no external APIs.

The test suite has been run with Node `v22.22.3`. The package uses Codex
plugin manifests with `.codex-plugin/plugin.json`, stdio MCP entries, and hook
payloads read as JSON from stdin.

## Commands

```sh
node bin/codex-lcm --help
node bin/codex-lcm mcp
node bin/codex-lcm hook UserPromptSubmit
node bin/codex-lcm install --dry-run  # optional manual wiring plan
node bin/codex-lcm status
node bin/codex-lcm health
node bin/codex-lcm stats
node bin/codex-lcm context-plan
node bin/codex-lcm benchmark long-context
node bin/codex-lcm uninstall --dry-run  # optional manual cleanup plan
```

Storage defaults to `~/.codex-lcm`. Override storage for hook and MCP operations with:

```sh
CODEX_LCM_HOME=/path/to/lcm-home node bin/codex-lcm health
```

Useful diagnostics and backfill commands:

```sh
node bin/codex-lcm doctor --json
node bin/codex-lcm import-codex-sessions --dry-run --json
node bin/codex-lcm import-codex-sessions --json
node bin/codex-lcm context-plan --session-id SESSION --json
node bin/codex-lcm benchmark long-context --json
```

`doctor` reports install wiring, storage health, capture state, summary index
state, and recommendations. `import-codex-sessions` imports existing Codex
session JSONL files from `~/.codex/sessions` unless `--from PATH` is provided.
It leaves source transcripts untouched and skips duplicate event IDs on repeated
runs. `context-plan` estimates recent-session token pressure and recommends
when to pack LCM context; it does not control Codex compaction. The benchmark
command generates a temporary synthetic long session and verifies old evidence
can still be recovered through `lcm_pack_context`.

## MCP Tools

Standard recall workflow:

- `lcm_grep`: find relevant sessions by searching summary nodes, session summaries, and high-signal events.
- `lcm_describe`: inspect a session, summary node, or indexed file reference, including depth, source IDs, lineage metadata, and large-output summaries.
- `lcm_expand`: expand one summary node into bounded source summary nodes and high-signal source events.
- `lcm_expand_query`: answer a focused retrieval need by searching matching summary nodes and recursively expanding their source lineage into bounded evidence. The default budget is 2000 tokens. Use `overview: true` for broad, source-rich lineage views. `sourceLimit` is per matched node/source expansion, and tight budgets reserve room for a focused source-event excerpt when one exists.
- `lcm_pack_context`: pack relevant summary-node context into a model-ready Markdown block.

Diagnostics and lower-level tools:

- `lcm_health`
- `lcm_stats`
- `lcm_context_plan`
- `lcm_current_session`
- `lcm_search_sessions`
- `lcm_get_session`
- `lcm_get_session_summary`
- `lcm_get_session_graph`
- `lcm_get_recent_context`
- `lcm_record_note`

## Installing

Native Codex plugin installation is the primary install path. It wires the MCP
server, hook manifest, and skill from `.codex-plugin/plugin.json`; no separate
`codex-lcm install` step is required.

Install the latest tagged release from GitHub:

```sh
codex plugin marketplace add Team-Volt/codex-lcm --ref v0.2.0
codex plugin add codex-lcm@codex-lcm
```

Or install as a Codex plugin from a local checkout:

```sh
codex plugin marketplace add /path/to/codex-lcm
codex plugin add codex-lcm@codex-lcm
```

The first TUI session after install asks you to review and trust the hooks. That review is expected because Codex hooks can run outside the sandbox after you trust them.

To upgrade an existing GitHub marketplace install to `v0.2.0`:

```sh
codex plugin marketplace remove codex-lcm
codex plugin marketplace add Team-Volt/codex-lcm --ref v0.2.0
codex plugin add codex-lcm@codex-lcm
```

To upgrade a local checkout install to `v0.2.0`:

```sh
git -C /path/to/codex-lcm fetch --tags origin
git -C /path/to/codex-lcm checkout v0.2.0
codex plugin add codex-lcm@codex-lcm
```

To keep following the moving `main` branch instead of a release tag:

```sh
codex plugin marketplace add Team-Volt/codex-lcm --ref main
codex plugin add codex-lcm@codex-lcm
```

If your `codex-lcm` marketplace is path-backed and you want to keep using that
checkout, use the local-checkout command above instead. The cache directory can
keep the same version-looking suffix after a local refresh; verify with
`codex plugin list`, `codex-lcm stats --json`, or the `lcm_stats` MCP tool after
restart.

Restart Codex Desktop or start a fresh Codex CLI/TUI session after updating.
Long-running clients keep the old plugin cache until they restart. If the update
changes hook command text, Codex may ask you to review and trust the hooks again.

To remove the native plugin, use Codex's plugin manager:

```sh
codex plugin remove codex-lcm@codex-lcm
```

### Manual Wiring Planner

`codex-lcm install` is retained for development, diagnostics, and manual or
older setups where you want to inspect equivalent MCP and hook wiring without
changing `~/.codex`:

```sh
node bin/codex-lcm install --dry-run
```

The dry run prints the `codex mcp add codex-lcm -- node ".../bin/codex-lcm" mcp` command and the hook entries that would be merged into `~/.codex/hooks.json`.

This command is not needed after native plugin installation. It does not modify
`~/.codex/config.toml`, `~/.codex/hooks.json`, or the installed skill.

The native Codex plugin files are:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `hooks/hooks.codex.json`
- `skills/lcm-recall/SKILL.md`

The repository also includes `.agents/plugins/marketplace.json`, which lets
Codex treat this checkout as a plugin marketplace source during development or
local installs.

The `lcm-recall` skill is loaded by native plugin installation and nudges Codex
to use LCM on resumes, compaction recovery, long-running work, and questions
that depend on prior local session context.

## What Is Captured

Hooks capture the JSON payload Codex sends on stdin for:

- `SessionStart`
- `UserPromptSubmit`
- `PreToolUse`
- `PostToolUse`
- `PreCompact`
- `PostCompact`
- `Stop`

Events store session ID, cwd, optional project string, optional git repo root, optional git branch, hook event name, sanitized payload, redaction metadata, truncation metadata, timestamps, and hashes. Large path-backed outputs are indexed as file references with path, byte count, SHA-256, MIME guess, and a compact exploration summary; the indexed metadata does not reload the full content.

Project and git data are metadata only. Search and retrieval are session-first and work for projectless sessions.

## DAG And Long Sessions

SQLite stores a derived DAG alongside FTS:

- Session nodes anchor each Codex session.
- Turn nodes group events with the same `turn_id`.
- Event nodes point back to raw event IDs.
- Checkpoint nodes are created on `PreCompact` and every 50 indexed events.
- Typed edges include `contains`, `next`, `tool_result`, `checkpoint`, and
  `summary_source`.

Unknown edge kinds use recursive cycle checks. Known internal edge kinds (`contains`, `next`, `tool_result`, `checkpoint`, and `summary_source`) skip that expensive check because they are derived from append-only session order or summary-source lineage. The graph is derived from raw events and can be rebuilt; `events.jsonl` remains the source of truth.

SQLite also stores deterministic extractive summaries in `session_summaries` and
`session_summary_fts`. A summary contains a title, overview, topics, key user
prompts, outcomes, and source event IDs. It is not an LLM summary and it does
not replace raw events. It is a compact, rebuildable index that helps agents
find broad "semantic clue" matches before they decide which raw events or graph
slices to inspect.

Codex-generated suggestion prompts and their JSON suggestion responses stay in
the raw event log and exact event FTS, but they are not treated as summary
signal. That keeps generated "try this next" chatter from outranking actual work
sessions in broad discovery.

The summary-node layer adds a second derived index:

- D0 summary nodes summarize bounded chunks of high-signal events.
- D1 and deeper summary nodes summarize lower-depth summary nodes.
- `summary_source` edges are persisted and connect summary nodes back to their child nodes or raw event nodes.
- `summary_node_fts` lets retrieval search the summary DAG before falling back to raw event FTS.

This mirrors the lossless-context pattern used by systems such as lossless-claw
and Hermes LCM: search compact summary nodes first, then expand the selected
source lineage under the caller's token budget. Raw transcript events remain
available through `lcm_get_session`.

`PreCompact` marks the checkpoint before Codex rewrites the visible context.
`PostCompact` records the completion marker and any compacted summary payload
Codex provides, so later recall can tell that compaction finished.
Only `PostCompact` events with a `summary` or `reason` are promoted into session
summary text; empty completion markers are still stored and counted.

Use `lcm_stats` or `node bin/codex-lcm stats --json` to inspect aggregate index
shape without reading raw transcript text. The stats output includes summary
nodes by depth, summary source types, hook-event counts, graph node and edge
counts, freshness timestamps, max summary depth, `session_summary_count`,
`sessions_with_session_summary`, and the number of sessions with summary nodes.
The legacy `summary_count` field is kept as an alias for session summaries, not
summary nodes. Check `hook_event_counts.PreCompact` and
`hook_event_counts.PostCompact` when verifying that Codex compaction hooks are
being captured. Health and stats diagnostics open the index read-only; normal
hook ingestion and note writes perform derived-index maintenance.

Use `lcm_context_plan` or `node bin/codex-lcm context-plan --json` when an agent
needs to decide whether to call `lcm_pack_context`. It reports estimated recent
tokens, summary-node availability, soft-limit state, and recommended retrieval
tools. It is an observability surface only; Codex owns compaction.

For long sessions, summary rebuilds use a bounded sample of early high-signal
events, latest high-signal events, and recent events. That keeps ingestion fast
while preserving the initial task framing and the latest outcome.

For long sessions, `lcm_get_session` accepts `limit` and `cursor`,
`lcm_get_session_graph` returns bounded graph slices including summary nodes,
and `lcm_pack_context` prioritizes matching summary nodes plus bounded source
expansion. This avoids missing old-but-relevant events just because they are
outside the latest event window.

For broad questions, search is intentionally two-pass. Codex LCM tries strict
SQLite FTS first, then falls back to a relaxed term query when the strict query
has no hits. Session results are ordered by discovery confidence first, then raw
match strength. Each `lcm_search_sessions` result includes a `best_match` clue
with the match kind, snippet, score, timestamp, and available source metadata.
It also includes `discovery`, a compact confidence object with `high`, `medium`,
or `low`, a score, and the reasons behind that ranking. Tiny one-event sessions
are downranked for broad discovery queries, while exact marker-style searches
still work. Agents can also pass `excludeCurrentSession` or `excludeSessionIds`
when they are looking for prior history and the current chat is repeating the
same terms.

`lcm_pack_context` keeps cwd scoping when it finds high-signal matches, but if a
cwd-scoped query is empty it performs a bounded global fallback so broad meta
questions do not return empty or misleadingly narrow context just because the
current directory is too narrow. Packed context excludes LCM self-reference tool
chatter and generated suggestion chatter, and prefers summary-node source
lineage over arbitrary raw tool output.

`node bin/codex-lcm benchmark long-context --json` runs a local synthetic
retrieval check. It creates temporary storage, imports a long session with an old
needle event, and verifies `lcm_pack_context` recovers that source under a
bounded budget. Pass `--home PATH` to keep the benchmark storage for inspection.

## Privacy And Safety

Before writing to disk, Codex LCM:

- Redacts secret-like keys such as `api_key`, `token`, `password`, `secret`, `authorization`, `cookie`, and `private_key`.
- Redacts obvious token strings such as bearer tokens, `sk-...`, GitHub tokens, Slack tokens, and AWS access key IDs.
- Truncates oversized strings and payloads with SHA-256 hash metadata.
- Stores sanitized raw events before derived indexes or summaries.

If SQLite is unavailable, raw JSONL append still works and retrieval falls back to scanning `events.jsonl`.

## Testing

```sh
npm test
npm run smoke
npm --cache /tmp/codex-lcm-npm-cache pack --dry-run
```

The smoke test uses a temporary `CODEX_LCM_HOME`, sends synthetic hook events,
starts the MCP server over stdio, calls grep/describe/expand, graph, and
pack-context tools, and cleans up the temporary directory unless
`CODEX_LCM_KEEP_SMOKE=1` is set.

Use a temporary npm cache for `npm pack --dry-run` if your global npm cache has
local permission issues.

## Known Limitations

- Embeddings are not implemented. Search is SQLite FTS plus raw-log fallback.
- Session summaries are deterministic and extractive; they do not call an LLM or external summarizer.
- Checkpoints are structural; they track graph/session shape rather than prose summaries.
- Hook payload compatibility is based on verified local Codex/installed-plugin behavior and tolerant parsing.
- `codex-lcm install` and `codex-lcm uninstall` are dry-run manual wiring planners. Native plugin install and removal are handled by `codex plugin add` and `codex plugin remove`.
- `node:sqlite` is used through Node 22 and should be treated as a local runtime dependency.

## License

Codex LCM is released under the MIT License. See `LICENSE` for the full text.
