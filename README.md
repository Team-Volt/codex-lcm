# Codex LCM

Codex LCM is a local context memory plugin for Codex. It captures Codex session
events, stores sanitized raw history first, builds local search and graph indexes
from that history, and exposes retrieval through MCP tools that Codex can call
when prior work matters.

LCM stands for lossless context memory. The project is designed around a simple
constraint: do not rely on a project, repository, summary, or embedding as the
source of truth. A Codex session is the primary unit. Project path, git repo,
and branch are metadata that make retrieval easier, but projectless sessions
still work.

## What It Does

- Records Codex lifecycle events from hooks such as session start, user prompt,
  tool use, compaction, and stop.
- Writes sanitized raw events to an append-only JSONL log before doing any
  indexing work.
- Builds a local SQLite index with FTS search and a derived DAG of sessions,
  turns, events, tool results, checkpoints, and summary-source lineage.
- Builds deterministic extractive session summaries with titles, topics, key
  prompts, outcomes, tools, and source event IDs. These summaries are derived
  from raw events and can be rebuilt.
- Serves MCP tools for the standard LCM flow: grep for candidates, describe
  sessions or summary nodes, expand source-backed evidence, pack model-ready
  context, check health/stats, page long sessions, inspect graphs, and record
  approved notes.
- Provides a Codex skill that nudges the model to query LCM on resumes,
  compaction recovery, long-running work, and questions about prior sessions.

The current release stores data locally. It does not require external APIs,
hosted services, or embeddings.

## How Codex Uses It

Codex uses LCM through two surfaces:

- Hooks capture session events automatically while Codex runs.
- MCP tools let Codex retrieve relevant context later.

A typical retrieval flow is:

1. Locate the current or latest relevant session by cwd, repo root, or session ID.
2. Use `lcm_grep` to search across summary nodes, session summaries, and
   high-signal events. Search tries exact FTS first, then relaxes broad queries
   so one missing word does not make retrieval look empty.
3. Use `lcm_describe` on a promising session or summary node to inspect the
   summary, depth, source IDs, and lineage before loading more.
4. Use `lcm_expand` on a chosen summary node, `lcm_expand_query` when the query
   should pick and recursively expand matching nodes, or `lcm_pack_context` when
   Codex needs a ready-to-use context block. Pass `overview: true` to
   `lcm_expand_query` for broad, source-rich lineage views.
5. Page through long sessions or request a bounded graph slice instead of loading
   an entire raw history at once.

This keeps Codex from guessing what happened before while avoiding giant context
dumps.

## Architecture

The plugin package lives in `plugins/codex-lcm/`.

```text
plugins/codex-lcm/
  .codex-plugin/plugin.json   Codex plugin manifest
  .mcp.json                   MCP server registration
  hooks/hooks.codex.json      Codex hook registration
  skills/lcm-recall/          Codex skill for retrieval guidance
  src/                        TypeScript implementation
  tests/                      Node test suite
```

Storage defaults to `~/.codex-lcm`:

```text
~/.codex-lcm/
  events.jsonl     append-only sanitized raw events
  index.sqlite     derived SQLite FTS, summary, and DAG index
```

`events.jsonl` is the source of truth. The SQLite database is rebuildable and is
allowed to fail without losing raw events.

## Privacy And Safety

Codex LCM stores local session data, so it treats capture as a privacy-sensitive
operation.

- Obvious secret keys such as tokens, passwords, cookies, API keys, and private
  keys are redacted before storage.
- Common token strings such as bearer tokens, OpenAI keys, GitHub tokens, Slack
  tokens, and AWS access key IDs are redacted.
- Oversized strings and payloads are truncated with SHA-256 hash metadata.
- Large file contents are not blindly treated as durable knowledge; hook payloads
  are sanitized and size-limited before persistence.
- Raw sanitized events are kept locally unless the user chooses to copy, export,
  or publish them elsewhere.

## Installation

Install the latest tagged release from GitHub with Codex's native plugin flow:

```sh
codex plugin marketplace add Team-Volt/codex-lcm --ref v0.2.5
codex plugin add codex-lcm@codex-lcm
```

Or install from a local checkout:

```sh
codex plugin marketplace add /path/to/codex-lcm
codex plugin add codex-lcm@codex-lcm
```

The native plugin manifest wires the MCP server, lifecycle hooks, and
`lcm-recall` skill. No separate `codex-lcm` CLI install step is required.

The first TUI session after install asks you to review and trust the lifecycle
hooks. That is expected. Hooks capture the session data that LCM indexes.

Upgrade an existing GitHub marketplace install to `v0.2.5`:

```sh
codex plugin marketplace remove codex-lcm
codex plugin marketplace add Team-Volt/codex-lcm --ref v0.2.5
codex plugin add codex-lcm@codex-lcm
```

Upgrade a local checkout install to `v0.2.5` by checking out the release tag,
then asking Codex to refresh the installed plugin cache:

```sh
git -C /path/to/codex-lcm fetch --tags origin
git -C /path/to/codex-lcm checkout v0.2.5
codex plugin add codex-lcm@codex-lcm
```

To keep following the moving `main` branch instead of a release tag, use:

```sh
codex plugin marketplace add Team-Volt/codex-lcm --ref main
codex plugin add codex-lcm@codex-lcm
```

If your `codex-lcm` marketplace is path-backed and you want to keep using that
checkout, use the local-checkout command above instead. The cache directory may
keep the same version suffix after a local refresh; use `codex plugin list`,
`codex-lcm stats --json`, or the `lcm_stats` MCP tool after restart to verify
the loaded code.

Then restart Codex Desktop or open a new Codex CLI/TUI session so the refreshed
plugin cache, MCP server, hooks, and skill are loaded. If a release changes hook
commands, Codex may ask you to review and trust the updated hooks again.

Remove it with:

```sh
codex plugin remove codex-lcm@codex-lcm
```

## Release Status

Current release: `v0.2.5`.

Codex LCM is a local-first Codex memory plugin with native plugin installation,
hook ingestion, sanitized raw event storage, SQLite FTS, DAG-backed retrieval,
deterministic summaries, recursive summary-node expansion, context packing,
health/stats diagnostics, post-compaction capture, and Codex session import
tools. The `lcm-recall` skill gives Codex a repeatable retrieval workflow for
resumes, compaction recovery, long-running work, and questions about prior
sessions.

### v0.2.5 notes

This patch release recovers context within the turn that triggered compaction
and reduces unnecessary storage work.

- Defers post-compaction recovery output to supported hook events, injects the
  recovery directive after the next tool result, and blocks completion until
  context packing clears the pending marker.
- Reconciles edited or truncated raw logs with the index and rejects malformed
  optional string arrays at the MCP boundary.
- Preserves unchanged summary rows during rebuilds and queries top summary nodes
  directly, reducing repeated rebuild time in the measured benchmark.

Use the [Installation](#installation) section for install and upgrade commands.

## Development

Run commands from the plugin package:

```sh
cd plugins/codex-lcm
npm test
npm run smoke
```

The smoke test uses a temporary `CODEX_LCM_HOME`, sends synthetic hook events,
starts the MCP server over stdio, calls search, graph, and context-packing
tools, and cleans up after itself.

Useful local commands:

```sh
node bin/codex-lcm --help
node bin/codex-lcm doctor --json
node bin/codex-lcm health --json
node bin/codex-lcm stats --json
node bin/codex-lcm status --json
node bin/codex-lcm import-codex-sessions --dry-run --json
```

`doctor --json` combines plugin wiring status, storage health, event capture,
summary indexing, and concrete recommendations. `import-codex-sessions` scans
existing Codex JSONL transcripts, defaulting to `~/.codex/sessions`, and ingests
them into LCM without modifying the source files. Use `--dry-run` first to see
how many records are importable; repeated imports skip duplicate event IDs.

`stats --json` includes `hook_event_counts`, so `PreCompact` capture can be
checked without opening raw logs or SQLite.

For deeper implementation notes, see:

- `plugins/codex-lcm/README.md`
- `plugins/codex-lcm/docs/architecture.md`
- `plugins/codex-lcm/docs/troubleshooting.md`

## License

Codex LCM is released under the MIT License. See `LICENSE` for the full text.
