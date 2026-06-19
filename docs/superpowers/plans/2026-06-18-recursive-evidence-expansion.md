# Recursive Evidence Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `lcm_expand_query` MCP tool that finds matching summary nodes and recursively expands their source lineage under a token budget.

**Architecture:** Reuse the existing summary-node search, ranking, and source-lineage tables. Add one storage method that searches candidate summary nodes, walks child summary nodes depth-first with cycle guards, fetches focused source events, and returns Markdown plus structured source metadata. Expose it through MCP as a read-only tool.

**Tech Stack:** TypeScript, Node 22 `node:test`, local SQLite via `node:sqlite`, existing MCP JSON-RPC server.

---

### Task 1: Storage API

**Files:**
- Modify: `plugins/codex-lcm/src/storage.ts`
- Test: `plugins/codex-lcm/tests/dag.test.ts`

- [ ] **Step 1: Write a failing storage test**

Add a test that ingests 40 high-signal events, calls `storage.expandQuery({ query, cwd, budgetTokens })`, and asserts:
- the returned Markdown includes the direct query match
- multiple summary-node depths are represented
- the estimated token count stays within budget
- source metadata includes summary nodes and raw events

- [ ] **Step 2: Run the focused test**

Run: `npm test -- tests/dag.test.ts`

Expected: fail because `expandQuery` does not exist.

- [ ] **Step 3: Implement `expandQuery`**

Add exported types for query expansion, candidate selection through `searchSummaryNodes`, recursive source-node descent, source-event fetching, budget-aware Markdown packing, and cycle protection.

- [ ] **Step 4: Re-run the focused test**

Run: `npm test -- tests/dag.test.ts`

Expected: pass.

### Task 2: MCP Tool

**Files:**
- Modify: `plugins/codex-lcm/src/mcp.ts`
- Test: `plugins/codex-lcm/tests/mcp.test.ts`

- [ ] **Step 1: Write failing MCP tests**

Update the tool list assertion to include `lcm_expand_query`. Add a tool-call test that confirms `structuredContent.expansion.query`, `markdown`, `sources`, and `truncated` are returned.

- [ ] **Step 2: Run the focused MCP test**

Run: `npm test -- tests/mcp.test.ts`

Expected: fail because the MCP tool is not registered.

- [ ] **Step 3: Register the MCP tool**

Add the tool schema and dispatch case. Required input: `query`. Optional inputs: `cwd`, `repoRoot`, `sessionIds`, `budgetTokens`, `limit`, and `sourceLimit`.

- [ ] **Step 4: Re-run the focused MCP test**

Run: `npm test -- tests/mcp.test.ts`

Expected: pass.

### Task 3: Docs and verification

**Files:**
- Modify: `plugins/codex-lcm/README.md`

- [ ] **Step 1: Update the tool list**

Document `lcm_expand_query` as deterministic recursive evidence expansion, not LLM synthesis.

- [ ] **Step 2: Run full verification**

Run:

```sh
cd plugins/codex-lcm
npm test
npm run smoke
```

Expected: both commands exit 0.
