# DAG Context Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implemented. This file is retained as the historical execution
plan for the DAG, long-session retrieval, and skill-nudge work.

**Goal:** Add a real derived DAG layer, efficient long-session retrieval, and Codex-native nudges while preserving append-only raw events as the source of truth.

**Architecture:** Raw JSONL remains lossless source data. SQLite becomes a rebuildable derived index with session/event tables, FTS, graph nodes, graph edges, checkpoint nodes, cycle prevention, and graph-aware context packing.

**Tech Stack:** TypeScript, Node.js 22 `node:sqlite`, JSONL, SQLite FTS5, Codex MCP, Codex plugin skills.

---

## File Structure

- Modify `src/storage.ts`: graph schema, event metadata columns, DAG indexing, cycle checks, graph retrieval, event search, paged session retrieval, graph-aware context packing.
- Modify `src/mcp.ts`: expose `lcm_get_session_graph`; add paging options to `lcm_get_session`; update instructions to nudge retrieval.
- Modify `.codex-plugin/plugin.json`: add `skills` path.
- Create `skills/lcm-recall/SKILL.md`: practical instructions for when and how Codex should use LCM.
- Modify `README.md`, `docs/architecture.md`, and `docs/design.md`: document DAG, long-session behavior, and nudge behavior.
- Add `tests/dag.test.ts`: DAG correctness, cycle prevention, long-session query retrieval, paged session retrieval, checkpoint creation.
- Modify `tests/mcp.test.ts`: MCP tool list and graph retrieval.
- Modify `tests/plugin-manifest.test.ts`: plugin skill path and skill presence.
- Modify `scripts/smoke-test.ts`: verify graph tool and long-session query packing.

## Task 1: Failing Tests

- [x] Add `tests/dag.test.ts` covering:
  - `getSessionGraph()` returns session, turn, event, checkpoint nodes and typed edges.
  - `wouldCreateCycleForTest()` detects a back-edge cycle.
  - `getSession()` supports `limit` and `cursor` without loading every event.
  - `packContext()` includes an old matching event from a long session instead of only recent tail events.
  - `PreCompact` creates a checkpoint node.
- [x] Update `tests/mcp.test.ts` to expect `lcm_get_session_graph`.
- [x] Update `tests/plugin-manifest.test.ts` to expect a `skills` manifest entry and `skills/lcm-recall/SKILL.md`.
- [x] Run targeted tests and verify they fail for missing behavior:
  - `npm test -- tests/dag.test.ts`
  - `npm test -- tests/mcp.test.ts`
  - `npm test -- tests/plugin-manifest.test.ts`

## Task 2: DAG Storage

- [x] Extend SQLite schema with `turn_id` and `tool_use_id` columns on `events`.
- [x] Add `graph_nodes` and `graph_edges` tables with typed node/edge fields, metadata JSON, and indexes.
- [x] Add deterministic node IDs:
  - `session:<session_id>`
  - `turn:<session_id>:<turn_id>`
  - `event:<event_id>`
  - `checkpoint:<session_id>:<event_count>`
- [x] Build graph edges during ingestion:
  - `session -> turn/event` as `contains`
  - `turn -> event` as `contains`
  - previous event -> current event as `next`
  - matching `PreToolUse -> PostToolUse` as `tool_result`
  - `session -> checkpoint` as `checkpoint`
- [x] Prevent cycles before inserting edges using a recursive CTE from prospective child to prospective parent.
- [x] Keep all derived indexing inside a transaction after raw append. If indexing fails, raw append must remain durable.

## Task 3: Long-Session Retrieval

- [x] Add summary-node search over FTS with bounded source-event expansion.
- [x] Add `getSessionGraph(sessionId, limit)` returning bounded nodes and edges.
- [x] Add paged `getSession(sessionId, { limit, cursor })` returning `next_cursor`.
- [x] Update `packContext()` to prioritize matching events, graph neighbors, latest checkpoint nodes, then bounded recent tail.
- [x] Keep raw-log fallback behavior usable when SQLite is unavailable.

## Task 4: MCP And Skill Nudge

- [x] Add MCP tool `lcm_get_session_graph`.
- [x] Add optional `limit` and `cursor` to `lcm_get_session`.
- [x] Update MCP server instructions to tell Codex to use LCM on resume, after compaction, when prior context is likely relevant, and before answering memory-dependent questions.
- [x] Add `skills/lcm-recall/SKILL.md` with specific tool-use guidance.
- [x] Add `"skills": "./skills/"` to `.codex-plugin/plugin.json`.

## Task 5: Docs And Verification

- [x] Update architecture/design docs for DAG tables, edge invariants, checkpoints, and long-session retrieval.
- [x] Update README with new MCP tool and skill.
- [x] Run:
  - `npm test`
  - `npm run smoke`
  - `node --no-warnings bin/codex-lcm health --json`
- [x] Inspect `git diff` for accidental unrelated changes.
