import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { normalizeHookEvent } from "../src/events.ts";
import { createStorage } from "../src/storage.ts";
import { tempHome } from "./helpers.ts";

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

test("packs extractive session summaries before raw events", () => {
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

  const summaryIndex = packed.markdown.indexOf("Session Summary");
  const rawIndex = packed.markdown.indexOf("UserPromptSubmit");
  assert.notEqual(summaryIndex, -1);
  assert.notEqual(rawIndex, -1);
  assert.equal(summaryIndex < rawIndex, true);
  assert.match(packed.markdown, /Topics: .*summarization/u);
  assert.match(packed.markdown, /Sources: /u);
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
