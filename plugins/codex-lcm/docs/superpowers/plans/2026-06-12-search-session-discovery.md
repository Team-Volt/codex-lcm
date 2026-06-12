# Search Session Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `lcm_search_sessions` a better discovery tool by returning explainable match metadata and supporting current-session exclusion.

**Architecture:** Keep `lcm_pack_context` as the model-ready context path. Improve `searchSessions()` so each returned session carries a compact best-match record from summary-node, session-summary, or raw-event search. Add optional exclusion inputs so agents can search prior history without the current chat dominating results.

**Tech Stack:** TypeScript on Node.js, built-in `node:test`, SQLite FTS through `node:sqlite`, existing deterministic summary-node indexes.

---

### Task 1: Storage Search Match Metadata

**Files:**
- Modify: `plugins/codex-lcm/src/storage.ts`
- Test: `plugins/codex-lcm/tests/storage.test.ts`

- [x] **Step 1: Write failing tests**

Add tests proving `searchSessions()` returns `best_match.kind`, `best_match.snippet`, and summary-node topics; add a test proving `excludeCurrentSession` omits the latest cwd session and returns older matching sessions.

- [x] **Step 2: Verify tests fail**

Run: `npm test -- tests/storage.test.ts`

Expected: failures because `best_match` and `excludeCurrentSession` do not exist yet.

- [x] **Step 3: Implement minimal storage changes**

Extend `SearchSessionArgs` and `SessionSummary` with optional discovery fields. Add search-row metadata for match kind, timestamp, source IDs, topics, and a bounded snippet. Filter excluded sessions before ranking.

- [x] **Step 4: Verify storage tests pass**

Run: `npm test -- tests/storage.test.ts`

Expected: all storage tests pass.

### Task 2: MCP Surface

**Files:**
- Modify: `plugins/codex-lcm/src/mcp.ts`
- Test: `plugins/codex-lcm/tests/mcp.test.ts`

- [x] **Step 1: Write failing MCP test**

Assert that `lcm_search_sessions` returns `best_match` in structured content and accepts `excludeCurrentSession`.

- [x] **Step 2: Verify MCP test fails**

Run: `npm test -- tests/mcp.test.ts`

Expected: failure before the MCP schema and argument parsing are updated.

- [x] **Step 3: Implement minimal MCP changes**

Add `excludeCurrentSession` and `excludeSessionIds` to the tool schema and pass both into `storage.searchSessions()`.

- [x] **Step 4: Verify MCP test passes**

Run: `npm test -- tests/mcp.test.ts`

Expected: all MCP tests pass.

### Task 3: Full Verification

**Files:**
- Existing test suite only.

- [x] **Step 1: Run full test suite**

Run: `npm test`

Expected: 48+ tests pass with no failures.

- [x] **Step 2: Run smoke test**

Run: `npm run smoke`

Expected: smoke test passes.

- [x] **Step 3: Inspect diff**

Run: `git diff --check` and `git status --short --branch`

Expected: no whitespace errors and only intended files changed.

### Task 4: Search Noise Regression Cleanup

**Files:**
- Modify: `plugins/codex-lcm/src/storage.ts`
- Modify: `plugins/codex-lcm/src/summary.ts`
- Test: `plugins/codex-lcm/tests/storage.test.ts`
- Docs: `plugins/codex-lcm/README.md`, `plugins/codex-lcm/docs/design.md`, `plugins/codex-lcm/skills/lcm-recall/SKILL.md`

- [x] **Step 1: Reproduce generated-suggestion dominance**

Add a regression where a generated Codex suggestion session contains the same
terms as a real work session. Verify it fails because the suggestion session
ranks first.

- [x] **Step 2: Exclude generated suggestions from summaries**

Keep generated suggestion prompts and JSON suggestion responses in the raw event
log and event FTS, but exclude them from session summaries and summary nodes.
Bump summary and summary-node versions so existing indexes rebuild.

- [x] **Step 3: Reproduce raw tool chatter fallback**

Add a regression where a matching `PostToolUse` event is the only hit. Verify it
fails because raw tool chatter is returned as a search-discovery match.

- [x] **Step 4: Restrict event fallback to high-signal events**

Keep raw events available through session retrieval, but limit
`lcm_search_sessions` event fallback to `UserPromptSubmit`, `Note`, `Stop`, and
`PreCompact`.

- [x] **Step 5: Verify**

Run `npm test`, `npm run smoke`, `git diff --check`, refresh the installed plugin
cache, and smoke-test the installed cache.

### Task 5: Discovery Confidence Ranking

**Files:**
- Modify: `plugins/codex-lcm/src/storage.ts`
- Test: `plugins/codex-lcm/tests/storage.test.ts`
- Test: `plugins/codex-lcm/tests/mcp.test.ts`
- Docs: `plugins/codex-lcm/README.md`, `plugins/codex-lcm/docs/design.md`, `plugins/codex-lcm/skills/lcm-recall/SKILL.md`

- [x] **Step 1: Reproduce tiny-session dominance**

Add a regression where a one-event marker-style session shares the broad query
terms with a source-rich implementation-history session. Verify current raw
match scoring ranks the tiny session first.

- [x] **Step 2: Add discovery confidence**

Keep `best_match.score` as raw match strength. Add `discovery.confidence`,
`discovery.score`, and `discovery.reasons` as the session-lead quality signal.
Rank by discovery score before raw match score.

- [x] **Step 3: Keep exact lookups intact**

Apply the tiny-session penalty only to broad discovery queries so exact
marker-style searches remain discoverable.

- [x] **Step 4: Document the distinction**

Update README, design notes, and the recall skill so agents use
`discovery.confidence` for first-pass triage and treat `best_match.score` as
match strength rather than relevance by itself.
