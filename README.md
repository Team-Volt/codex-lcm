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
- Serves MCP tools for health checks, current-session lookup, cross-session
  search, paged session retrieval, graph retrieval, context packing, and notes.
- Provides a Codex skill that nudges the model to query LCM on resumes,
  compaction recovery, long-running work, and questions about prior sessions.

The first working version is local-only. It does not require external APIs,
hosted services, or embeddings.

## How Codex Uses It

Codex uses LCM through two surfaces:

- Hooks capture session events automatically while Codex runs.
- MCP tools let Codex retrieve relevant context later.

A typical retrieval flow is:

1. Locate the current or latest relevant session by cwd, repo root, or session ID.
2. Search across sessions when the user asks about prior work or when the task
   resumes an older thread.
3. Pack a bounded context block from matching events, nearby graph context,
   checkpoints, notes, and recent session tails.
4. Page through long sessions or request a bounded graph slice instead of loading
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
  index.sqlite     derived SQLite FTS and DAG index
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

## Public Status

This repository is being prepared for public use. The implementation is already
usable locally, but the public installation and release story is still evolving.
The current focus is correctness, transparent capture semantics, durable local
storage, and Codex-native retrieval behavior.

## Installation

Install from a local checkout with Codex's native plugin flow:

```sh
codex plugin marketplace add /path/to/codex-lcm
codex plugin add codex-lcm@codex-lcm
```

The native plugin manifest wires the MCP server, lifecycle hooks, and
`lcm-recall` skill. You do not need to run `codex-lcm install` after
`codex plugin add`; that command is only a dry-run manual wiring planner for
development or compatibility checks.

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
node bin/codex-lcm status --json
```

For deeper implementation notes, see:

- `plugins/codex-lcm/README.md`
- `plugins/codex-lcm/docs/design.md`
- `plugins/codex-lcm/docs/architecture.md`
- `plugins/codex-lcm/docs/troubleshooting.md`
