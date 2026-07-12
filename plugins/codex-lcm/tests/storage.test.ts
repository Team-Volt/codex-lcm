import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { normalizeHookEvent, type NormalizedEvent } from "../src/events.ts";
import { createStorage } from "../src/storage.ts";
import { clearDerivedSummaries, readJsonl, tempHome } from "./helpers.ts";

const now = () => new Date("2026-06-09T12:00:00.000Z");

test("appends JSONL and indexes searchable cross-session events", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "s1", cwd: "/tmp/a", prompt: "alpha pool chemistry" }),
    env: {},
    now,
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "s2", cwd: "/tmp/b", prompt: "beta app store copy" }),
    env: {},
    now,
  }));

  const health = storage.health();
  assert.equal(health.event_count, 2);
  assert.equal(health.session_count, 2);
  assert.equal(health.raw_log_exists, true);

  const matches = storage.searchSessions({ query: "pool chemistry", limit: 5 });
  assert.deepEqual(matches.map((match) => match.session_id), ["s1"]);
  assert.equal(matches[0].cwd, "/tmp/a");

  storage.close();
});

test("stats reports aggregate summary and graph shape without raw content", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  ingestStatsFixture(storage);

  const stats = storage.stats();

  assert.equal(stats.event_count, 9);
  assert.equal(stats.session_count, 1);
  assert.equal(stats.summary_count, 1);
  assert.equal(stats.session_summary_count, 1);
  assert.equal(stats.summary_node_count, 3);
  assert.deepEqual(stats.hook_event_counts, { PreCompact: 1, UserPromptSubmit: 8 });
  assert.deepEqual(stats.summary_nodes_by_depth, { "0": 2, "1": 1 });
  assert.deepEqual(stats.summary_nodes_by_source_type, { events: 2, nodes: 1 });
  assert.equal(stats.sessions_with_session_summary, 1);
  assert.equal(stats.sessions_with_summary_nodes, 1);
  assert.equal(stats.max_summary_depth, 1);
  assert.equal(stats.latest_event_at, "2026-06-09T12:00:08.000Z");
  assert.equal(stats.latest_summary_node_at, "2026-06-09T12:00:08.000Z");
  assert.equal(stats.graph_nodes_by_kind.event, 9);
  assert.equal(stats.graph_nodes_by_kind.session, 1);
  assert.equal(stats.graph_edges_by_kind.contains, 9);
  assert.equal(stats.graph_edges_by_kind.summary_source, 11);
  assert.equal("raw_json" in stats, false);

  storage.close();
});

test("read-only storage opens do not rebuild derived indexes", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  ingestStatsFixture(storage);
  storage.close();

  clearDerivedSummaries(home);

  const readOnlyStorage = createStorage({ home, readOnly: true });
  const stats = readOnlyStorage.stats();

  assert.equal(stats.event_count, 9);
  assert.equal(stats.summary_count, 0);
  assert.equal(stats.summary_node_count, 0);
  assert.equal(stats.index_error, undefined);

  readOnlyStorage.close();
});

test("read-only single ingest rejects an event that is already raw-durable", () => {
  const home = tempHome();
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "read-only-ingest-session",
      cwd: "/tmp/read-only-ingest",
      prompt: "existing raw event stays read only",
    }),
    env: {},
    now,
  });
  const storage = createStorage({ home });
  storage.ingest(event);
  storage.close();
  const readOnlyStorage = createStorage({ home, readOnly: true });

  assert.throws(() => readOnlyStorage.ingest(event), /read-only storage/u);

  readOnlyStorage.close();
});

test("context plan reports budget pressure without claiming compaction control", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const prompt = "context budget pressure ".repeat(40);

  for (let index = 0; index < 12; index += 1) {
    storage.ingest(normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: "context-plan-session",
        cwd: "/tmp/context-plan",
        prompt: `${prompt}${index}`,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
    }));
  }

  const plan = storage.getContextPlan({
    sessionId: "context-plan-session",
    modelContextWindow: 20_000,
    autoCompactTokenLimit: 200,
  });

  assert.equal(plan.session_id, "context-plan-session");
  assert.equal(plan.can_control_compaction, false);
  assert.equal(plan.state, "over_limit");
  assert.equal(plan.summary_node_count, 3);
  assert.equal(plan.estimated_recent_tokens > plan.auto_compact_token_limit, true);
  assert.equal(plan.latest_event_at, "2026-06-09T12:00:11.000Z");
  assert.equal(plan.suggested_tools.includes("lcm_pack_context"), true);
  assert.match(plan.recommendation, /lcm_pack_context/u);

  storage.close();
});

test("context plan includes summary-node tokens in pressure state", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  for (let index = 0; index < 40; index += 1) {
    storage.ingest(normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: "context-plan-summary-pressure-session",
        cwd: "/tmp/context-plan-summary-pressure",
        prompt: `summary pressure topic ${index}`,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 9, 13, 0, index)),
    }));
  }

  const plan = storage.getContextPlan({
    sessionId: "context-plan-summary-pressure-session",
    modelContextWindow: 20_000,
    autoCompactTokenLimit: 120,
    recentEventLimit: 1,
  });

  assert.equal(plan.estimated_recent_tokens < plan.auto_compact_token_limit, true);
  assert.equal(plan.estimated_total_tokens >= plan.auto_compact_token_limit, true);
  assert.equal(plan.state, "over_limit");

  storage.close();
});

test("writable storage replays raw JSONL events that are missing from SQLite index", () => {
  const home = tempHome();
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "raw-replay-session",
      cwd: "/tmp/raw-replay",
      prompt: "raw replay prompt should be searchable",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  });
  fs.writeFileSync(path.join(home, "events.jsonl"), `${JSON.stringify(event)}\n`, { mode: 0o600 });

  const storage = createStorage({ home });

  assert.equal(storage.health().event_count, 1);
  assert.deepEqual(storage.searchSessions({ query: "raw replay searchable", limit: 5 }).map((match) => match.session_id), [
    "raw-replay-session",
  ]);
  assert.equal(storage.getSessionMemorySummary("raw-replay-session")?.updated_at, "2026-06-09T12:00:00.000Z");

  storage.close();
});

test("writable storage preserves indexed rows and replays valid events when raw JSONL is partial", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const indexedOnly = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "partial-indexed-session",
      cwd: "/tmp/partial-indexed",
      prompt: "keep this usable indexed evidence",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  });
  const rawOnly = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "partial-raw-session",
      cwd: "/tmp/partial-raw",
      prompt: "replay this complete raw evidence",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:01.000Z"),
  });

  storage.ingest(indexedOnly);
  storage.close();
  fs.writeFileSync(
    path.join(home, "events.jsonl"),
    `${JSON.stringify(rawOnly)}\n{"event_id":"partial`,
    { mode: 0o600 },
  );

  const reopened = createStorage({ home });
  const health = reopened.health();

  assert.equal(health.event_count, 2);
  assert.match(health.index_error ?? "", /malformed|partial/iu);
  assert.deepEqual(reopened.searchSessions({ query: "usable indexed evidence", limit: 5 }).map((match) => match.session_id), [
    "partial-indexed-session",
  ]);
  assert.deepEqual(reopened.searchSessions({ query: "complete raw evidence", limit: 5 }).map((match) => match.session_id), [
    "partial-raw-session",
  ]);

  reopened.close();
});

test("writable storage removes stale SQLite rows when raw JSONL is truncated", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const retained = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "raw-retained", cwd: "/tmp/raw-retained", prompt: "retained raw prompt" }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  });
  const stale = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "raw-stale", cwd: "/tmp/raw-stale", prompt: "stale sqlite prompt" }),
    env: {},
    now: () => new Date("2026-06-09T12:00:01.000Z"),
  });

  storage.ingest(retained);
  storage.ingest(stale);
  storage.close();
  fs.writeFileSync(path.join(home, "events.jsonl"), `${JSON.stringify(retained)}\n`, { mode: 0o600 });

  const reopened = createStorage({ home });

  assert.equal(reopened.health().event_count, 1);
  assert.deepEqual(reopened.searchSessions({ query: "retained", limit: 5 }).map((match) => match.session_id), ["raw-retained"]);
  assert.deepEqual(reopened.searchSessions({ query: "stale", limit: 5 }).map((match) => match.session_id), []);
  assert.equal(reopened.getSession("raw-stale").events.length, 0);

  reopened.close();
});

test("writable storage clears SQLite when raw JSONL is emptied", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "raw-empty", cwd: "/tmp/raw-empty", prompt: "remove all indexed rows" }),
    env: {},
    now,
  }));
  storage.close();
  fs.writeFileSync(path.join(home, "events.jsonl"), "", { mode: 0o600 });

  const reopened = createStorage({ home });

  assert.equal(reopened.health().event_count, 0);
  assert.equal(reopened.health().session_count, 0);
  assert.deepEqual(reopened.searchSessions({ query: "remove all indexed rows", limit: 5 }), []);

  reopened.close();
});

test("writable storage repairs same-count raw and SQLite event ID mismatches", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const indexedOnly = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "indexed-only", cwd: "/tmp/indexed-only", prompt: "indexed only stale prompt" }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  });
  const rawOnly = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "raw-only", cwd: "/tmp/raw-only", prompt: "raw only replacement prompt" }),
    env: {},
    now: () => new Date("2026-06-09T12:00:01.000Z"),
  });

  storage.ingest(indexedOnly);
  storage.close();
  fs.writeFileSync(path.join(home, "events.jsonl"), `${JSON.stringify(rawOnly)}\n`, { mode: 0o600 });

  const reopened = createStorage({ home });

  assert.equal(reopened.health().event_count, 1);
  assert.deepEqual(reopened.searchSessions({ query: "replacement", limit: 5 }).map((match) => match.session_id), ["raw-only"]);
  assert.deepEqual(reopened.searchSessions({ query: "stale", limit: 5 }).map((match) => match.session_id), []);

  reopened.close();
});

test("tool chatter does not rebuild session summaries until a landmark event", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "summary-refresh-session",
      cwd: "/tmp/summary-refresh",
      prompt: "initial summary source",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));

  const initialSummary = storage.getSessionMemorySummary("summary-refresh-session");
  assert.equal(initialSummary?.updated_at, "2026-06-09T12:00:00.000Z");

  storage.ingest(normalizeHookEvent({
    hookEvent: "PreToolUse",
    rawInput: JSON.stringify({
      session_id: "summary-refresh-session",
      cwd: "/tmp/summary-refresh",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_input: { command: "echo performance" },
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:01.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "PostToolUse",
    rawInput: JSON.stringify({
      session_id: "summary-refresh-session",
      cwd: "/tmp/summary-refresh",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_response: { output: "performance" },
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:02.000Z"),
  }));

  const unchangedSummary = storage.getSessionMemorySummary("summary-refresh-session");
  assert.equal(unchangedSummary?.updated_at, "2026-06-09T12:00:00.000Z");

  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: "summary-refresh-session",
      cwd: "/tmp/summary-refresh",
      last_assistant_message: "finished performance work",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:03.000Z"),
  }));

  const refreshedSummary = storage.getSessionMemorySummary("summary-refresh-session");
  assert.equal(refreshedSummary?.updated_at, "2026-06-09T12:00:03.000Z");
  assert.deepEqual(refreshedSummary?.tools, ["Bash"]);

  storage.close();
});

test("reopening indexed storage reconciles same-ID raw-log payload edits", () => {
  // Given
  const home = tempHome("codex-lcm-raw-prefix-edit-");
  const storage = createStorage({ home });
  const events = Array.from({ length: 30 }, (_, index) => normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "raw-prefix-edit",
      cwd: "/tmp/raw-prefix-edit",
      prompt: `original-${String(index).padStart(3, "0")}-${"x".repeat(150)}`,
    }),
    env: {},
    now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
  }));
  storage.ingestMany(events);
  storage.close();
  const rawLogPath = path.join(home, "events.jsonl");
  const lines = fs.readFileSync(rawLogPath, "utf8").trimEnd().split(/\r?\n/u);
  const replacement = JSON.parse(lines[0]) as NormalizedEvent;
  lines[0] = JSON.stringify({
    ...replacement,
    payload: { ...replacement.payload, prompt: String(replacement.payload.prompt).replace("original-000", "modified-000") },
  });
  fs.writeFileSync(rawLogPath, `${lines.join("\n")}\n`);

  // When
  const reopened = createStorage({ home });

  // Then
  assert.equal(reopened.searchSessions({ query: "original-000" }).length, 0);
  assert.deepEqual(reopened.searchSessions({ query: "modified-000" }).map((session) => session.session_id), ["raw-prefix-edit"]);
  reopened.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("ingest restores a raw event removed while storage remains open", () => {
  // Given
  const home = tempHome("codex-lcm-live-raw-truncate-");
  const storage = createStorage({ home });
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "live-raw-truncate", cwd: "/tmp/live-raw-truncate", prompt: "restore raw source" }),
    env: {},
    now,
  });
  storage.ingest(event);
  fs.truncateSync(path.join(home, "events.jsonl"), 0);

  // When
  storage.ingest(event);

  // Then
  const rawEvents = readJsonl(path.join(home, "events.jsonl"));
  assert.equal(rawEvents.length, 1);
  assert.match(JSON.stringify(rawEvents[0]), new RegExp(event.event_id, "u"));
  storage.close();
});

test("summary rebuild preserves unchanged node rows", () => {
  // Given
  const home = tempHome("codex-lcm-incremental-summary-");
  const sessionId = "incremental-summary";
  const storage = createStorage({ home });
  const events = Array.from({ length: 16 }, (_, index) => normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: sessionId, cwd: "/tmp/incremental-summary", prompt: `summary source ${index}` }),
    env: {},
    now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
  }));
  storage.ingestMany(events);
  const db = new DatabaseSync(path.join(home, "index.sqlite"));
  const unchanged = db.prepare("SELECT rowid, node_id FROM summary_nodes WHERE session_id = ?1 AND depth = 0 ORDER BY earliest_at LIMIT 1").get(sessionId) as { rowid: number; node_id: string };
  db.exec(`
    CREATE TABLE summary_node_audit (action TEXT NOT NULL, node_id TEXT NOT NULL);
    CREATE TRIGGER audit_summary_node_delete AFTER DELETE ON summary_nodes BEGIN
      INSERT INTO summary_node_audit (action, node_id) VALUES ('delete', OLD.node_id);
    END;
    CREATE TRIGGER audit_summary_node_insert AFTER INSERT ON summary_nodes BEGIN
      INSERT INTO summary_node_audit (action, node_id) VALUES ('insert', NEW.node_id);
    END;
  `);

  // When
  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({ session_id: sessionId, cwd: "/tmp/incremental-summary", last_assistant_message: "latest summary outcome" }),
    env: {},
    now: () => new Date("2026-06-09T12:05:00.000Z"),
  }));

  // Then
  assert.equal(db.prepare("SELECT rowid FROM summary_nodes WHERE node_id = ?1").get(unchanged.node_id)?.rowid, unchanged.rowid);
  assert.deepEqual(db.prepare("SELECT action FROM summary_node_audit WHERE node_id = ?1").all(unchanged.node_id), []);
  db.close();
  storage.close();
  fs.rmSync(home, { recursive: true, force: true });
});

test("coalesces prompt-only summary rebuilds but keeps stop freshness", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "prompt-coalesce-session",
      cwd: "/tmp/prompt-coalesce",
      prompt: "initial prompt summary source",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  assert.equal(storage.getSessionMemorySummary("prompt-coalesce-session")?.updated_at, "2026-06-09T12:00:00.000Z");

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "prompt-coalesce-session",
      cwd: "/tmp/prompt-coalesce",
      prompt: "second prompt should wait for a landmark",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:01.000Z"),
  }));
  assert.equal(storage.getSessionMemorySummary("prompt-coalesce-session")?.updated_at, "2026-06-09T12:00:00.000Z");

  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: "prompt-coalesce-session",
      cwd: "/tmp/prompt-coalesce",
      last_assistant_message: "landmark outcome refreshed the coalesced prompt summary",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:02.000Z"),
  }));

  const refreshed = storage.getSessionMemorySummary("prompt-coalesce-session");
  assert.equal(refreshed?.updated_at, "2026-06-09T12:00:02.000Z");
  assert.equal(refreshed?.key_prompts.some((prompt) => prompt.includes("second prompt")), true);
  assert.equal(refreshed?.outcomes.some((outcome) => outcome.includes("landmark outcome")), true);

  storage.close();
});

test("post-compaction payloads refresh session summaries as high-signal outcomes", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "postcompact-session",
      cwd: "/tmp/postcompact",
      prompt: "track the compaction recovery path",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "PostCompact",
    rawInput: JSON.stringify({
      session_id: "postcompact-session",
      cwd: "/tmp/postcompact",
      trigger: "auto",
      summary: "context compacted and ready for bounded LCM recall",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:01.000Z"),
  }));

  const summary = storage.getSessionMemorySummary("postcompact-session");
  assert.equal(summary?.updated_at, "2026-06-09T12:00:01.000Z");
  assert.match(summary?.overview ?? "", /bounded LCM recall/u);
  assert.equal(summary?.source_event_ids.length, 2);
  assert.deepEqual(storage.stats().hook_event_counts, { PostCompact: 1, UserPromptSubmit: 1 });

  storage.close();
});

test("bulk ingest appends raw events once and rebuilds summaries once per touched session", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const sessionId = "bulk-ingest-session";
  const cwd = "/tmp/bulk-ingest";
  const events: NormalizedEvent[] = [
    "first bulk import prompt",
    "second bulk import prompt",
    "third bulk import prompt",
  ].map((prompt, index) => normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: sessionId, cwd, prompt }),
    env: {},
    now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
  }));
  events.push(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: sessionId,
      cwd,
      last_assistant_message: "bulk import final outcome",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:03.000Z"),
  }));

  const internals = storage as unknown as {
    rebuildSessionMemorySummary(sessionId: string): void;
  };
  const originalRebuild = internals.rebuildSessionMemorySummary.bind(storage);
  let rebuilds = 0;
  internals.rebuildSessionMemorySummary = (id: string) => {
    rebuilds += 1;
    originalRebuild(id);
  };

  const result = (storage as unknown as {
    ingestMany(events: NormalizedEvent[]): { imported: number; skippedDuplicate: number; touchedSessions: string[] };
  }).ingestMany([...events, events[0]]);

  assert.equal(result.imported, 4);
  assert.equal(result.skippedDuplicate, 1);
  assert.deepEqual(result.touchedSessions, [sessionId]);
  assert.equal(rebuilds, 1);
  assert.equal(readJsonl(path.join(home, "events.jsonl")).length, 4);
  assert.equal(storage.health().event_count, 4);
  assert.equal(storage.getSessionMemorySummary(sessionId)?.outcomes.includes("bulk import final outcome"), true);

  storage.close();
});

test("bulk ingest reuses the raw event ID cache warmed by single ingest", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const sessionId = "bulk-cache-session";
  const cwd = "/tmp/bulk-cache";
  const rawLogPath = path.join(home, "events.jsonl");

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: sessionId, cwd, prompt: "seed raw event for cache warmup" }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));

  const fsModule = fs as typeof fs & { readFileSync: typeof fs.readFileSync };
  const originalReadFileSync = fsModule.readFileSync;
  let rawLogReads = 0;
  fsModule.readFileSync = ((...args: Parameters<typeof originalReadFileSync>) => {
    if (args[0] === rawLogPath) {
      rawLogReads += 1;
    }
    return originalReadFileSync(...args);
  }) as typeof originalReadFileSync;

  try {
    const bulkIngest = storage as unknown as {
      ingestMany(events: NormalizedEvent[]): { imported: number; skippedDuplicate: number; touchedSessions: string[] };
    };

    for (let batchIndex = 0; batchIndex < 4; batchIndex += 1) {
      const events = Array.from({ length: 500 }, (_, eventIndex) => normalizeHookEvent({
        hookEvent: "UserPromptSubmit",
        rawInput: JSON.stringify({
          session_id: sessionId,
          cwd,
          prompt: `cache batch ${batchIndex} event ${eventIndex}`,
        }),
        env: {},
        now: () => new Date(Date.UTC(2026, 5, 9, 12, batchIndex, eventIndex)),
      }));

      const result = bulkIngest.ingestMany(events);
      assert.equal(result.imported, 500);
      assert.equal(result.skippedDuplicate, 0);
      assert.deepEqual(result.touchedSessions, [sessionId]);
    }

    assert.equal(rawLogReads, 0);
    assert.equal(storage.health().event_count, 2001);
  } finally {
    fsModule.readFileSync = originalReadFileSync;
    storage.close();
  }
});

test("bulk ingest can defer summary rebuilds until touched sessions are finalized", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const sessionId = "bulk-deferred-summary-session";
  const events = Array.from({ length: 4 }, (_, index) => normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: sessionId,
      cwd: "/tmp/bulk-deferred-summary",
      prompt: `deferred summary prompt ${index}`,
    }),
    env: {},
    now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
  }));

  const first = storage.ingestMany(events.slice(0, 2), { rebuildSummaries: false });
  const second = storage.ingestMany(events.slice(2), { rebuildSummaries: false });

  assert.deepEqual(first.touchedSessions, [sessionId]);
  assert.deepEqual(second.touchedSessions, [sessionId]);
  assert.equal(storage.getSessionMemorySummary(sessionId), undefined);

  const rebuilt = storage.rebuildSessionMemorySummaries([...first.touchedSessions, ...second.touchedSessions]);

  assert.deepEqual(rebuilt, [sessionId]);
  assert.equal(storage.getSessionMemorySummary(sessionId)?.key_prompts.includes("deferred summary prompt 3"), true);

  storage.close();
});

test("bulk ingest retry after SQLite rollback does not duplicate raw JSONL", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "bulk-rollback-session",
      cwd: "/tmp/bulk-rollback",
      prompt: "bulk rollback retry prompt",
    }),
    env: {},
    now,
  });
  const internals = storage as unknown as {
    indexEventInTransaction: (event: NormalizedEvent, options: { rebuildSummary: boolean }) => unknown;
  };
  const originalIndexEventInTransaction = internals.indexEventInTransaction;
  internals.indexEventInTransaction = () => {
    throw new Error("forced index failure");
  };

  try {
    assert.throws(() => storage.ingestMany([event]), /forced index failure/u);
  } finally {
    internals.indexEventInTransaction = originalIndexEventInTransaction;
  }
  assert.equal(readJsonl(path.join(home, "events.jsonl")).length, 1);

  const retried = storage.ingestMany([event]);

  assert.equal(retried.imported, 0);
  assert.equal(retried.skippedDuplicate, 1);
  assert.equal(readJsonl(path.join(home, "events.jsonl")).length, 1);
  assert.equal(storage.health().event_count, 1);
  assert.deepEqual(storage.searchSessions({ query: "rollback retry", limit: 5 }).map((match) => match.session_id), [
    "bulk-rollback-session",
  ]);

  storage.close();
});

test("single ingest keeps a raw-durable event when SQLite indexing fails", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "single-index-failure-session",
      cwd: "/tmp/single-index-failure",
      prompt: "durable hook survives index failure",
    }),
    env: {},
    now,
  });
  const internals = storage as unknown as {
    indexEventInTransaction: (event: NormalizedEvent, options: { rebuildSummary: boolean }) => unknown;
  };
  const originalIndexEventInTransaction = internals.indexEventInTransaction;
  internals.indexEventInTransaction = () => {
    throw new Error("forced single index failure");
  };

  try {
    assert.doesNotThrow(() => storage.ingest(event));
  } finally {
    internals.indexEventInTransaction = originalIndexEventInTransaction;
  }

  assert.equal(readJsonl(path.join(home, "events.jsonl")).length, 1);
  assert.match(storage.health().index_error ?? "", /forced single index failure/u);

  storage.close();
});

test("bulk ingest surfaces SQLite lock timeouts instead of reporting a successful no-op", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const blocker = new DatabaseSync(path.join(home, "index.sqlite"));
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "bulk-lock-timeout-session",
      cwd: "/tmp/bulk-lock-timeout",
      prompt: "do not silently drop this locked import",
    }),
    env: {},
    now,
  });

  blocker.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => storage.ingestMany([event]), /database is locked/iu);
    assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    storage.close();
  }
});

test("single ingest surfaces SQLite lock timeouts before raw persistence", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const blocker = new DatabaseSync(path.join(home, "index.sqlite"));
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "single-lock-timeout-session",
      cwd: "/tmp/single-lock-timeout",
      prompt: "locked hook must reach the caller",
    }),
    env: {},
    now,
  });

  blocker.exec("BEGIN IMMEDIATE");
  try {
    assert.throws(() => storage.ingest(event), /database is locked/iu);
    assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
    storage.close();
  }
});

test("concurrent bulk ingest writers append an event ID to raw JSONL once", async () => {
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "concurrent-bulk-session",
      cwd: "/tmp/concurrent-bulk",
      prompt: "concurrent durable import",
    }),
    env: {},
    now,
  });
  const result = await runConcurrentIngestWriters(["bulk", "bulk"], event);

  assert.equal(result.rawEventCount, 1);
  assert.equal(result.indexedEventCount, 1);
  assert.equal(result.rawAppendAttempts, 1);
});

test("concurrent single ingest writers append an event ID to raw JSONL once", async () => {
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "concurrent-single-session",
      cwd: "/tmp/concurrent-single",
      prompt: "concurrent single durable hook",
    }),
    env: {},
    now,
  });
  const result = await runConcurrentIngestWriters(["single", "single"], event);

  assert.equal(result.rawEventCount, 1);
  assert.equal(result.indexedEventCount, 1);
  assert.equal(result.rawAppendAttempts, 1);
});

test("concurrent single and bulk ingest writers append an event ID to raw JSONL once", async () => {
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "concurrent-mixed-session",
      cwd: "/tmp/concurrent-mixed",
      prompt: "concurrent mixed durable hook",
    }),
    env: {},
    now,
  });
  const result = await runConcurrentIngestWriters(["single", "bulk"], event);

  assert.equal(result.rawEventCount, 1);
  assert.equal(result.indexedEventCount, 1);
  assert.equal(result.rawAppendAttempts, 1);
});

test("indexes large path-backed tool outputs as file references", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const content = JSON.stringify({
    rows: Array.from({ length: 800 }, (_, index) => ({ id: index, label: `large file row ${index}` })),
  });

  storage.ingest(normalizeHookEvent({
    hookEvent: "PostToolUse",
    rawInput: JSON.stringify({
      session_id: "file-ref-session",
      cwd: "/tmp/file-ref",
      tool_name: "Read",
      tool_response: {
        file_path: "/tmp/file-ref/data.json",
        result: { content },
      },
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));

  const refs = storage.getFileRefsForSession("file-ref-session");

  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, "/tmp/file-ref/data.json");
  assert.equal(refs[0].session_id, "file-ref-session");
  assert.equal(refs[0].mime_type, "application/json");
  assert.equal(refs[0].byte_count, Buffer.byteLength(content, "utf8"));
  assert.match(refs[0].file_ref_id, /^file:/u);
  assert.match(refs[0].sha256, /^[a-f0-9]{64}$/u);
  assert.match(refs[0].exploration_summary, /JSON object/u);
  assert.match(refs[0].exploration_summary, /rows/u);

  const described = storage.getFileRef(refs[0].file_ref_id);
  assert.deepEqual(described, refs[0]);

  storage.close();
});

test("writable storage backfills file references for existing indexed events", () => {
  const home = tempHome();
  const content = JSON.stringify({
    rows: Array.from({ length: 800 }, (_, index) => ({ id: index, label: `backfill file row ${index}` })),
  });
  const storage = createStorage({ home });
  storage.ingest(normalizeHookEvent({
    hookEvent: "PostToolUse",
    rawInput: JSON.stringify({
      session_id: "file-ref-backfill-session",
      cwd: "/tmp/file-ref-backfill",
      tool_name: "Read",
      tool_response: {
        file_path: "/tmp/file-ref-backfill/data.json",
        content,
      },
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.close();

  const db = new DatabaseSync(path.join(home, "index.sqlite"));
  try {
    db.exec("DELETE FROM file_refs");
    try {
      db.exec("DELETE FROM index_metadata WHERE key = 'file_refs_backfilled_v1'");
    } catch {
      // Old indexes did not have migration metadata.
    }
  } finally {
    db.close();
  }

  const reopened = createStorage({ home });
  const refs = reopened.getFileRefsForSession("file-ref-backfill-session");

  assert.equal(refs.length, 1);
  assert.equal(refs[0].path, "/tmp/file-ref-backfill/data.json");
  assert.equal(refs[0].byte_count, Buffer.byteLength(content, "utf8"));

  reopened.close();
});

test("post-compaction reason text is a summary signal fallback", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "PostCompact",
    rawInput: JSON.stringify({
      session_id: "postcompact-reason-session",
      cwd: "/tmp/postcompact-reason",
      trigger: "manual",
      reason: "manual compaction finished after context got tight",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));

  const summary = storage.getSessionMemorySummary("postcompact-reason-session");
  assert.match(summary?.overview ?? "", /context got tight/u);
  assert.deepEqual(summary?.outcomes, ["manual compaction finished after context got tight"]);

  storage.close();
});

test("empty post-compaction events do not refresh derived summaries", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "empty-postcompact-session",
      cwd: "/tmp/empty-postcompact",
      prompt: "initial compaction setup",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));

  storage.ingest(normalizeHookEvent({
    hookEvent: "PostCompact",
    rawInput: JSON.stringify({
      session_id: "empty-postcompact-session",
      cwd: "/tmp/empty-postcompact",
      trigger: "auto",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:01.000Z"),
  }));

  const summary = storage.getSessionMemorySummary("empty-postcompact-session");
  assert.equal(summary?.updated_at, "2026-06-09T12:00:00.000Z");
  assert.deepEqual(summary?.source_event_ids.length, 1);
  assert.deepEqual(storage.stats().hook_event_counts, { PostCompact: 1, UserPromptSubmit: 1 });

  storage.close();
});

test("post-compaction does not create checkpoint nodes", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "PreCompact",
    rawInput: JSON.stringify({
      session_id: "compact-checkpoint-session",
      cwd: "/tmp/compact-checkpoint",
      reason: "before compact",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "PostCompact",
    rawInput: JSON.stringify({
      session_id: "compact-checkpoint-session",
      cwd: "/tmp/compact-checkpoint",
      summary: "after compact",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:01.000Z"),
  }));

  const graph = storage.getSessionGraph("compact-checkpoint-session", { limit: 20 });
  assert.equal(graph.nodes.filter((node) => node.kind === "checkpoint").length, 1);
  assert.deepEqual(storage.stats().hook_event_counts, { PostCompact: 1, PreCompact: 1 });

  storage.close();
});

test("search sessions relaxes broad queries when strict FTS has no match", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "broad-session",
      cwd: "/tmp/broad",
      prompt: "codex-lcm retrieval quality notes",
    }),
    env: {},
    now,
  }));

  const matches = storage.searchSessions({
    query: "how is codex-lcm working out retrieval quality plumbing intelligence layer",
    limit: 5,
  });

  assert.deepEqual(matches.map((match) => match.session_id), ["broad-session"]);

  storage.close();
});

test("search sessions ranks substantive broad matches ahead of newer shallow matches", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "substantive-session",
      cwd: "/tmp/broad",
      prompt: "codex-lcm retrieval quality plumbing intelligence layer assessment",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "shallow-session",
      cwd: "/tmp/broad",
      prompt: "quality",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:01:00.000Z"),
  }));

  const matches = storage.searchSessions({
    query: "how is codex-lcm working out retrieval quality plumbing intelligence layer",
    limit: 2,
  });

  assert.deepEqual(matches.map((match) => match.session_id), ["substantive-session", "shallow-session"]);

  storage.close();
});

test("search sessions merges summary and raw-event candidates before ranking a query tier", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "summary-candidate",
      cwd: "/tmp/merged-search",
      prompt: "merged evidence",
    }),
    env: {},
    now,
  }));
  for (let index = 0; index < 5; index += 1) {
    storage.ingest(normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: "raw-candidate",
        cwd: "/tmp/merged-search",
        prompt: `merged evidence raw occurrence ${index}`,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 9, 12, 1, index)),
    }));
  }
  storage.close();

  const db = new DatabaseSync(path.join(home, "index.sqlite"));
  try {
    db.prepare("DELETE FROM event_fts WHERE session_id = ?1").run("summary-candidate");
    db.prepare("DELETE FROM session_summary_fts WHERE session_id = ?1").run("summary-candidate");
    db.prepare("DELETE FROM summary_node_fts WHERE session_id = ?1").run("raw-candidate");
    db.prepare("DELETE FROM session_summary_fts WHERE session_id = ?1").run("raw-candidate");
  } finally {
    db.close();
  }

  const readOnlyStorage = createStorage({ home, readOnly: true });
  const matches = readOnlyStorage.searchSessions({ query: "merged evidence", limit: 2 });

  assert.deepEqual(matches.map((match) => match.session_id), ["raw-candidate", "summary-candidate"]);
  assert.equal(matches[0].best_match?.kind, "event");
  assert.equal(matches[0].match_count, 5);

  readOnlyStorage.close();
});

test("retrieves recent context by explicit session or latest cwd match", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "SessionStart",
    rawInput: JSON.stringify({ session_id: "older", cwd: "/tmp/work", message: "first" }),
    env: {},
    now: () => new Date("2026-06-09T11:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "newer", cwd: "/tmp/work", prompt: "latest context" }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));

  assert.equal(storage.getCurrentSession({ cwd: "/tmp/work" })?.session_id, "newer");
  assert.equal(storage.getRecentContext({ cwd: "/tmp/work", limit: 5 }).session_id, "newer");
  assert.equal(storage.getRecentContext({ sessionId: "older", limit: 5 }).events[0].session_id, "older");

  storage.close();
});

test("records notes and packs context within a budget", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.recordNote({
    sessionId: "note-session",
    cwd: "/tmp/notes",
    text: "Important design note about session-first retrieval.",
  });

  const packed = storage.packContext({
    query: "session-first",
    budgetTokens: 80,
  });

  assert.match(packed.markdown, /Important design note/u);
  assert.equal(packed.sources.some((source) => source.kind === "note"), true);
  assert.ok(packed.estimated_tokens <= 80);

  storage.close();
});

test("packs summary nodes before bounded source events", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "summary-session",
      cwd: "/tmp/summary",
      prompt: "Improve codex-lcm summarization ranking with topic extraction and provenance.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: "summary-session",
      cwd: "/tmp/summary",
      last_assistant_message: "Implemented deterministic session summaries, indexed topics, and source event pointers.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:01:00.000Z"),
  }));

  const packed = storage.packContext({
    cwd: "/tmp/summary",
    query: "summarization ranking topic extraction provenance",
    budgetTokens: 350,
  });

  const summaryIndex = packed.markdown.indexOf("Summary Node");
  const sourceIndex = packed.markdown.indexOf("Source Events");
  assert.notEqual(summaryIndex, -1);
  assert.notEqual(sourceIndex, -1);
  assert.equal(summaryIndex < sourceIndex, true);
  assert.match(packed.markdown, /Topics: .*summarization/u);
  assert.match(packed.markdown, /UserPromptSubmit/u);
  assert.equal(packed.sources.some((source) => source.kind === "summary" && source.session_id === "summary-session"), true);

  storage.close();
});

test("search sessions uses extracted summary topics for broad semantic clues", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "semantic-session",
      cwd: "/tmp/semantic",
      prompt: "The retrieval layer should surface compact clue titles across sessions.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));

  const matches = storage.searchSessions({
    query: "semantic clue finding compact titles",
    limit: 5,
  });

  assert.deepEqual(matches.map((match) => match.session_id), ["semantic-session"]);

  storage.close();
});

test("search sessions explains the best summary-node match", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "discovery-session",
      cwd: "/tmp/discovery",
      prompt: "Improve search session discovery with summary node snippets and source lineage.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: "discovery-session",
      cwd: "/tmp/discovery",
      last_assistant_message: "Added explainable best-match metadata for session discovery.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:01:00.000Z"),
  }));

  const [match] = storage.searchSessions({
    query: "summary node snippets source lineage",
    limit: 5,
  });

  assert.equal(match.session_id, "discovery-session");
  assert.equal(match.best_match?.kind, "summary_node");
  assert.equal(typeof match.best_match?.score, "number");
  assert.match(match.best_match?.snippet ?? "", /summary node snippets|source lineage/u);
  assert.equal(match.best_match?.topics?.includes("summary"), true);
  assert.ok(match.best_match?.node_id?.startsWith("summary:discovery-session"));

  storage.close();
});

test("search sessions can exclude the latest cwd session to surface prior history", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const cwd = "/tmp/history-search";

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "prior-history",
      cwd,
      prompt: "Rebuild history for summary DAG ranking and source lineage retrieval.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "current-chat",
      cwd,
      prompt: "Current chat repeats summary DAG ranking source lineage terms while discussing search.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:05:00.000Z"),
  }));

  const matches = storage.searchSessions({
    cwd,
    query: "summary DAG ranking source lineage",
    limit: 5,
    excludeCurrentSession: true,
  });

  assert.deepEqual(matches.map((match) => match.session_id), ["prior-history"]);
  assert.equal(matches[0].best_match?.kind, "summary_node");

  storage.close();
});

test("search sessions prefer real work over generated suggestion sessions", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const cwd = "/tmp/suggestion-noise";

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "real-work",
      cwd,
      prompt: "Implement lossless-claw hermes-lcm style multi-depth summary DAG ranking and retrieval.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: "real-work",
      cwd,
      last_assistant_message: "Added source-rich summary nodes and tuned lcm_search_sessions discovery ranking.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:01:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "generated-suggestions",
      cwd,
      prompt: "# Overview Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: /tmp/suggestion-noise\nSuggest lossless-claw hermes-lcm multi-depth summary DAG ranking retrieval follow-up work.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:10:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: "generated-suggestions",
      cwd,
      last_assistant_message: JSON.stringify({
        suggestions: [{
          title: "Tune lossless-claw hermes-lcm ranking",
          description: "Search session discovery can mention multi-depth summary DAG ranking retrieval.",
        }],
      }),
    }),
    env: {},
    now: () => new Date("2026-06-09T12:11:00.000Z"),
  }));

  const matches = storage.searchSessions({
    cwd,
    query: "lossless-claw hermes-lcm multi-depth summary DAG ranking retrieval",
    limit: 5,
  });

  assert.equal(matches[0].session_id, "real-work");

  const auditMatches = storage.searchSessions({
    cwd,
    query: "hyperpersonalized suggestions",
    limit: 5,
  });

  assert.equal(auditMatches[0].session_id, "generated-suggestions");

  storage.close();
});

test("search sessions do not surface raw tool chatter as discovery matches", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "PostToolUse",
    rawInput: JSON.stringify({
      session_id: "tool-chatter",
      cwd: "/tmp/tool-chatter",
      tool_name: "Bash",
      tool_response: "lossless-claw hermes-lcm multi-depth summary DAG ranking retrieval",
    }),
    env: {},
    now,
  }));

  const matches = storage.searchSessions({
    query: "lossless-claw hermes-lcm multi-depth summary DAG ranking retrieval",
    limit: 5,
  });

  assert.deepEqual(matches.map((match) => match.session_id), []);

  storage.close();
});

test("search sessions only surface generated suggestions for explicit suggestion queries", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const cwd = "/tmp/generated-suggestion-only";

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "generated-suggestions-only",
      cwd,
      prompt: "# Overview Generate 0 to 3 hyperpersonalized suggestions for what this user can do with Codex in this local project: /tmp/generated-suggestion-only\nMention lossless-claw hermes-lcm multi-depth summary DAG ranking retrieval.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: "generated-suggestions-only",
      cwd,
      last_assistant_message: JSON.stringify({
        suggestions: [{
          title: "Tune lossless-claw hermes-lcm ranking",
          description: "Use multi-depth summary DAG ranking retrieval.",
        }],
      }),
    }),
    env: {},
    now: () => new Date("2026-06-09T12:01:00.000Z"),
  }));

  const broadMatches = storage.searchSessions({
    cwd,
    query: "lossless-claw hermes-lcm multi-depth summary DAG ranking retrieval",
    limit: 5,
  });

  assert.deepEqual(broadMatches.map((match) => match.session_id), []);

  const auditMatches = storage.searchSessions({
    cwd,
    query: "hyperpersonalized suggestions",
    limit: 5,
  });

  assert.deepEqual(auditMatches.map((match) => match.session_id), ["generated-suggestions-only"]);

  storage.close();
});

test("search sessions rank source-rich implementation history over tiny marker sessions", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const cwd = "/tmp/discovery-confidence";

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "implementation-history",
      cwd,
      prompt: "Implement summary DAG ranking retrieval with source lineage and confidence scoring.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:00:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: "implementation-history",
      cwd,
      last_assistant_message: "Finished implementation history: source-rich summary nodes, ranking signals, and retrieval verification.",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:01:00.000Z"),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "tiny-marker",
      cwd,
      prompt: "summary DAG ranking retrieval implementation history marker reply exactly",
    }),
    env: {},
    now: () => new Date("2026-06-09T12:10:00.000Z"),
  }));

  const matches = storage.searchSessions({
    cwd,
    query: "summary DAG ranking retrieval implementation history",
    limit: 5,
  });

  assert.deepEqual(matches.map((match) => match.session_id), ["implementation-history", "tiny-marker"]);
  assert.equal(matches[0].discovery?.confidence, "high");
  assert.equal(matches[1].discovery?.confidence, "low");
  assert.equal((matches[0].discovery?.score ?? 0) > (matches[1].discovery?.score ?? 0), true);

  storage.close();
});

test("search sessions prefer the strongest evidence when aggregate relevance ties", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const cwd = "/tmp/strongest-evidence";
  const strongSignals = [
    "alpha beta gamma delta",
    "epsilon alpha",
    "gamma",
    "delta",
  ];

  for (const [index, prompt] of strongSignals.entries()) {
    storage.ingest(normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({ session_id: "strong-evidence", cwd, prompt }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
    }));
  }
  for (let index = 0; index < 4; index += 1) {
    storage.ingest(normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({ session_id: "recent-adjacent", cwd, prompt: "alpha beta" }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 10, 12, 0, index)),
    }));
  }
  storage.close();
  clearDerivedSummaries(home);

  const readOnlyStorage = createStorage({ home, readOnly: true });
  const matches = readOnlyStorage.searchSessions({
    cwd,
    query: "alpha beta gamma delta epsilon",
    limit: 5,
  });

  assert.deepEqual(matches.map((match) => match.session_id), ["strong-evidence", "recent-adjacent"]);
  assert.equal(matches[0].best_match?.score, 4);
  assert.equal(matches[1].best_match?.score, 2);

  readOnlyStorage.close();
});

test("session summary topics prefer signal terms over prompt filler", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "topic-quality-session",
      cwd: "/tmp/topic-quality",
      prompt: "What is the summary stop words in the code? Why is that there? Is that kind of hacky? If so, improve it.",
    }),
    env: {},
    now,
  }));

  const summary = storage.getSessionMemorySummary("topic-quality-session");

  assert.ok(summary);
  assert.deepEqual(summary.topics.slice(0, 5), ["summary", "stop", "words", "code", "hacky"]);
  assert.equal(summary.topics.includes("that"), false);
  assert.equal(summary.topics.includes("there"), false);

  storage.close();
});

test("packed summaries expose latest matching prompts in long sessions", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const sessionId = "summary-tail-session";
  const cwd = "/tmp/summary-tail";

  for (let index = 0; index < 8; index += 1) {
    storage.ingest(normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: sessionId,
        cwd,
        prompt: index === 7
          ? "LATEST-TAIL-PROMPT improve codex-lcm retrieval summaries"
          : `older prompt ${index}`,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
    }));
  }

  const summary = storage.getSessionMemorySummary(sessionId);
  assert.ok(summary);
  assert.deepEqual(summary.topics.slice(0, 2), ["latest-tail-prompt", "codex-lcm"]);

  const packed = storage.packContext({
    cwd,
    query: "LATEST-TAIL-PROMPT retrieval summaries",
    budgetTokens: 320,
  });

  const latestPromptIndex = packed.markdown.indexOf("LATEST-TAIL-PROMPT");
  const rawEventIndex = packed.markdown.indexOf("UserPromptSubmit");
  assert.notEqual(latestPromptIndex, -1);
  assert.notEqual(rawEventIndex, -1);
  assert.equal(latestPromptIndex < rawEventIndex, true);

  storage.close();
});

test("session summaries include latest high-signal events in very long sessions", () => {
  const home = tempHome();
  const storage = createStorage({ home });
  const sessionId = "long-summary-session";
  const cwd = "/tmp/long-summary";

  for (let index = 0; index < 1001; index += 1) {
    storage.ingest(normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: sessionId,
        cwd,
        prompt: index === 0 ? "Initial long session summary topic" : `summary filler prompt ${index}`,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
    }));
  }
  storage.ingest(normalizeHookEvent({
    hookEvent: "Stop",
    rawInput: JSON.stringify({
      session_id: sessionId,
      cwd,
      last_assistant_message: "FINAL-LONG-SUMMARY-OUTCOME captured after the first thousand events.",
    }),
    env: {},
    now: () => new Date(Date.UTC(2026, 5, 9, 12, 20, 0)),
  }));

  const summary = storage.getSessionMemorySummary(sessionId);

  assert.ok(summary);
  assert.equal(summary.updated_at, "2026-06-09T12:20:00.000Z");
  assert.equal(summary.outcomes.some((outcome) => outcome.includes("FINAL-LONG-SUMMARY-OUTCOME")), true);
  assert.equal(summary.source_event_ids.length > 0, true);

  storage.close();
});

test("still appends raw JSONL when SQLite index is unavailable", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, "index.sqlite"));
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "raw-first", cwd: "/tmp/raw", prompt: "raw append survives" }),
    env: {},
    now,
  }));

  const raw = fs.readFileSync(path.join(home, "events.jsonl"), "utf8");
  assert.match(raw, /raw append survives/u);
  assert.equal(storage.health().event_count, 1);

  storage.close();
});

test("health falls back to raw JSONL when SQLite queries fail after open", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "health-query-fail", cwd: "/tmp/raw", prompt: "raw health fallback" }),
    env: {},
    now,
  }));

  (storage as unknown as { db: { prepare: () => never; close: () => void } }).db = {
    prepare() {
      throw new Error("query failure");
    },
    close() {},
  };

  const health = storage.health();
  assert.equal(health.index_available, false);
  assert.match(health.index_error ?? "", /query failure/u);
  assert.equal(health.event_count, 1);
  assert.equal(health.session_count, 1);

  storage.close();
});

test("context plan falls back to raw JSONL when SQLite queries fail after open", () => {
  const home = tempHome();
  const storage = createStorage({ home });

  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: "context-plan-query-fail", cwd: "/tmp/raw", prompt: "raw context plan fallback" }),
    env: {},
    now,
  }));

  (storage as unknown as { db: { prepare: () => never; close: () => void } }).db = {
    prepare() {
      throw new Error("query failure");
    },
    close() {},
  };

  const plan = storage.getContextPlan({ sessionId: "context-plan-query-fail" });
  assert.equal(plan.session_id, "context-plan-query-fail");
  assert.equal(plan.estimated_recent_tokens > 0, true);
  assert.equal(plan.state, "under_limit");

  storage.close();
});

function ingestStatsFixture(storage: ReturnType<typeof createStorage>): void {
  for (let index = 0; index < 8; index += 1) {
    storage.ingest(normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: "stats-session",
        cwd: "/tmp/stats",
        prompt: `stats fixture high signal prompt ${index}`,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
    }));
  }
  storage.ingest(normalizeHookEvent({
    hookEvent: "PreCompact",
    rawInput: JSON.stringify({
      session_id: "stats-session",
      cwd: "/tmp/stats",
      trigger: "auto",
      reason: "stats fixture compact marker",
    }),
    env: {},
    now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, 8)),
  }));
}

type ConcurrentIngestMode = "single" | "bulk";

async function runConcurrentIngestWriters(
  modes: readonly [ConcurrentIngestMode, ConcurrentIngestMode],
  event: NormalizedEvent,
): Promise<{ rawEventCount: number; indexedEventCount: number; rawAppendAttempts: number }> {
  const home = tempHome("codex-lcm-concurrent-ingest-");
  const rawLogPath = path.join(home, "events.jsonl");
  const initializedStorage = createStorage({ home });
  initializedStorage.close();
  const barrier = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5);
  const state = new Int32Array(barrier);
  const workerScript = String.raw`
    const fs = require("node:fs");
    const { workerData } = require("node:worker_threads");
    const state = new Int32Array(workerData.barrier);
    const signal = (index) => {
      Atomics.add(state, index, 1);
      Atomics.add(state, 4, 1);
      Atomics.notify(state, 4);
    };
    const originalAppendFileSync = fs.appendFileSync;
    fs.appendFileSync = (...args) => {
      if (args[0] === workerData.rawLogPath) {
        signal(2);
        while (Atomics.load(state, 2) < 2 && Atomics.load(state, 3) < 2) {
          const version = Atomics.load(state, 4);
          if (Atomics.load(state, 2) < 2 && Atomics.load(state, 3) < 2) {
            Atomics.wait(state, 4, version);
          }
        }
      }
      return originalAppendFileSync(...args);
    };

    (async () => {
      const { createStorage } = await import(workerData.storageUrl);
      const storage = createStorage({ home: workerData.home });
      const originalExec = storage.db.exec.bind(storage.db);
      storage.db.exec = (sql) => {
        if (sql === "BEGIN IMMEDIATE") signal(3);
        return originalExec(sql);
      };
      const readyWorkers = Atomics.add(state, 0, 1) + 1;
      if (readyWorkers === 2) {
        Atomics.store(state, 1, 1);
        Atomics.notify(state, 1);
      } else {
        Atomics.wait(state, 1, 0);
      }
      try {
        if (workerData.mode === "single") {
          storage.ingest(workerData.event);
        } else {
          storage.ingestMany([workerData.event], { rebuildSummaries: false });
        }
      } finally {
        storage.close();
      }
    })();
  `;
  const workers = modes.map((mode) => new Worker(workerScript, {
    eval: true,
    workerData: {
      barrier,
      event,
      home,
      mode,
      rawLogPath,
      storageUrl: new URL("../src/storage.ts", import.meta.url).href,
    },
  }));

  try {
    await Promise.all(workers.map((worker) => new Promise<void>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ingest worker exited with code ${code}`));
      });
    })));

    const reopened = createStorage({ home, readOnly: true });
    const indexedEventCount = reopened.health().event_count;
    reopened.close();
    return {
      rawEventCount: readJsonl(rawLogPath).length,
      indexedEventCount,
      rawAppendAttempts: Atomics.load(state, 2),
    };
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
    fs.rmSync(home, { recursive: true, force: true });
  }
}
