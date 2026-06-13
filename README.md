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
  turns, events, tool results, and checkpoints.
- Builds deterministic extractive session summaries with titles, topics, key
  prompts, outcomes, tools, and source event IDs. These summaries are derived
  from raw events and can be rebuilt.
- Serves MCP tools for health and stats checks, current-session lookup, cross-session
  search, session summaries, paged session retrieval, graph retrieval, context
  packing, and notes.
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
2. Search across sessions when the user asks about prior work or when the task
   resumes an older thread. Search tries exact FTS first, then relaxes broad
   queries so one missing word does not make retrieval look empty.
3. Pack a bounded context block from matching events, nearby graph context,
   session summaries, checkpoints, notes, and recent session tails. For moderate
   and large budgets, summaries appear before raw event blocks so Codex gets the
   gist first and can still inspect the evidence. If a cwd-scoped pack finds no
   matches, or only finds low-signal tool chatter, it falls back to a bounded
   global search before returning nothing.
4. Use `lcm_get_session_summary` for compact titles, topics, outcomes, and
   source event IDs before loading raw transcripts.
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

Install from GitHub with Codex's native plugin flow:

```sh
codex plugin marketplace add Team-Volt/codex-lcm --ref main
codex plugin add codex-lcm@codex-lcm
```

Or install from a local checkout:

```sh
codex plugin marketplace add /path/to/codex-lcm
codex plugin add codex-lcm@codex-lcm
```

The native plugin manifest wires the MCP server, lifecycle hooks, and
`lcm-recall` skill. You do not need to run `codex-lcm install` after
`codex plugin add`; that command is only a dry-run manual wiring planner for
development or compatibility checks.

The first TUI session after install asks you to review and trust the lifecycle
hooks. That is expected. Hooks capture the session data that LCM indexes.

Update a local checkout install by pulling the checkout, then asking Codex to
refresh the installed plugin cache:

```sh
git -C /path/to/codex-lcm pull --ff-only
codex plugin add codex-lcm@codex-lcm
```

Update an existing GitHub marketplace install with:

```sh
codex plugin marketplace upgrade codex-lcm
codex plugin add codex-lcm@codex-lcm
```

If `codex plugin marketplace upgrade codex-lcm` says the marketplace is not
configured as a Git marketplace, your `codex-lcm` marketplace is path-backed.
Use the local-checkout update command above instead. The cache directory may
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

Codex LCM is a `0.1` developer release. The core flow is implemented and tested:
native plugin install, hook ingestion, local storage, search, graph retrieval,
context packing, and the `lcm-recall` skill. The search backend is intentionally
simple for now: SQLite FTS plus deterministic extractive summaries. Embeddings
and hosted services are not required.

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
node bin/codex-lcm health --json
node bin/codex-lcm stats --json
node bin/codex-lcm status --json
```

For deeper implementation notes, see:

- `plugins/codex-lcm/README.md`
- `plugins/codex-lcm/docs/design.md`
- `plugins/codex-lcm/docs/architecture.md`
- `plugins/codex-lcm/docs/troubleshooting.md`

## License

Codex LCM is released under the MIT License. See `LICENSE` for the full text.
