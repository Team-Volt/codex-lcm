# Doctor and Codex Session Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CLI diagnostics for LCM installs and a command that imports existing Codex session JSONL files into a fresh LCM store.

**Architecture:** Keep both features in the CLI layer. `doctor` composes existing status and storage-health data into checks and recommendations. `import-codex-sessions` scans Codex transcript JSONL files, maps stable transcript records to existing LCM hook event types, and ingests through the normal storage path so indexing, summaries, and DAG updates stay consistent.

**Tech Stack:** TypeScript, Node 22 `node:test`, local filesystem scanning, existing LCM event normalization and SQLite storage.

---

### Task 1: Doctor command

**Files:**
- Create: `plugins/codex-lcm/src/doctor.ts`
- Modify: `plugins/codex-lcm/src/cli.ts`
- Test: `plugins/codex-lcm/tests/doctor-import.test.ts`

- [x] **Step 1: Write the failing CLI test**

Assert that `codex-lcm doctor --json` reports warning checks and recommendations for an empty, unwired install.

- [x] **Step 2: Verify the test fails**

Run: `npm test -- tests/doctor-import.test.ts`

Expected failure: `Unknown command: doctor`.

- [x] **Step 3: Implement the report builder and CLI command**

Build checks from `readStatus()` and `storage.health()` for plugin wiring, recall skill availability, SQLite index availability, event capture, and summary-node indexing.

- [x] **Step 4: Verify the doctor test passes**

Run: `npm test -- tests/doctor-import.test.ts`

Expected: doctor test passes.

### Task 2: Codex session import

**Files:**
- Create: `plugins/codex-lcm/src/codex-import.ts`
- Modify: `plugins/codex-lcm/src/cli.ts`
- Modify: `plugins/codex-lcm/src/storage.ts`
- Test: `plugins/codex-lcm/tests/doctor-import.test.ts`

- [x] **Step 1: Write failing import tests**

Cover `--dry-run`, real import, duplicate skipping, stats visibility, and retrieval through `lcm_pack_context`.

- [x] **Step 2: Verify the tests fail**

Run: `npm test -- tests/doctor-import.test.ts`

Expected failure: `Unknown command: import-codex-sessions`.

- [x] **Step 3: Implement scanner and mapper**

Scan `.jsonl` files under `--from` or `~/.codex/sessions`. Map `session_meta` to `SessionStart`, user messages to `UserPromptSubmit`, assistant messages to `Stop`, function calls to `PreToolUse`, and function outputs to `PostToolUse`. Skip synthetic context records.

- [x] **Step 4: Make import idempotent**

Add `LcmStorage.hasEvent(eventId)` and skip existing event IDs before ingesting.

- [x] **Step 5: Verify import tests pass**

Run: `npm test -- tests/doctor-import.test.ts`

Expected: import tests pass and repeated imports do not increase indexed event counts.

### Task 3: Documentation and verification

**Files:**
- Modify: `README.md`
- Modify: `plugins/codex-lcm/README.md`

- [x] **Step 1: Document the commands**

Add `doctor --json`, `import-codex-sessions --dry-run --json`, and `import-codex-sessions --json` to the command lists.

- [x] **Step 2: Run full verification**

Run:

```sh
cd plugins/codex-lcm
npm test
npm run smoke
```

Expected: both commands exit 0.
