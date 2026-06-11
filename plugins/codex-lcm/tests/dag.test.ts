import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { normalizeHookEvent } from "../src/events.ts";
import { createStorage } from "../src/storage.ts";
import { tempHome } from "./helpers.ts";

test("indexes sessions, turns, events, tool pairs, and checkpoints as a bounded DAG", () => {
  const storage = createStorage({ home: tempHome() });
  const sessionId = "graph-session";
  const cwd = "/tmp/dag";

  ingest(storage, "SessionStart", { session_id: sessionId, cwd }, "2026-06-09T12:00:00.000Z");
  ingest(storage, "UserPromptSubmit", {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd,
    prompt: "begin graph test",
  }, "2026-06-09T12:00:01.000Z");
  ingest(storage, "PreToolUse", {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd,
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_input: { command: "echo hello" },
  }, "2026-06-09T12:00:02.000Z");
  ingest(storage, "PostToolUse", {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd,
    tool_name: "Bash",
    tool_use_id: "tool-1",
    tool_response: { output: "hello" },
  }, "2026-06-09T12:00:03.000Z");
  ingest(storage, "PreCompact", {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd,
    reason: "manual compact",
  }, "2026-06-09T12:00:04.000Z");

  const graph = storage.getSessionGraph(sessionId, { limit: 100 });
  const kinds = new Set(graph.nodes.map((node) => node.kind));
  assert.equal(kinds.has("session"), true);
  assert.equal(kinds.has("turn"), true);
  assert.equal(kinds.has("event"), true);
  assert.equal(kinds.has("checkpoint"), true);

  const edgeKinds = new Set(graph.edges.map((edge) => edge.kind));
  assert.equal(edgeKinds.has("contains"), true);
  assert.equal(edgeKinds.has("next"), true);
  assert.equal(edgeKinds.has("tool_result"), true);
  assert.equal(edgeKinds.has("checkpoint"), true);

  const nodeIds = new Set(graph.nodes.map((node) => node.node_id));
  for (const edge of graph.edges) {
    assert.notEqual(edge.from_node_id, edge.to_node_id);
    assert.equal(nodeIds.has(edge.from_node_id), true);
    assert.equal(nodeIds.has(edge.to_node_id), true);
  }

  storage.close();
});

test("rejects edges that would introduce a graph cycle", () => {
  const storage = createStorage({ home: tempHome() });
  const sessionId = "cycle-session";
  const cwd = "/tmp/dag-cycle";

  ingest(storage, "SessionStart", { session_id: sessionId, cwd }, "2026-06-09T12:00:00.000Z");
  ingest(storage, "UserPromptSubmit", {
    session_id: sessionId,
    turn_id: "turn-cycle",
    cwd,
    prompt: "cycle guard",
  }, "2026-06-09T12:00:01.000Z");

  const graph = storage.getSessionGraph(sessionId, { limit: 20 });
  const sessionNode = graph.nodes.find((node) => node.kind === "session");
  const eventNode = graph.nodes.find((node) => node.kind === "event" && node.event_id);
  assert.ok(sessionNode);
  assert.ok(eventNode);
  const graphInternals = storage as unknown as {
    wouldCreateCycle(fromNodeId: string, toNodeId: string): boolean;
    insertGraphEdge(
      fromNodeId: string,
      toNodeId: string,
      kind: string,
      sessionId: string,
      position: number,
      createdAt: string,
    ): void;
  };
  assert.equal(graphInternals.wouldCreateCycle(eventNode.node_id, sessionNode.node_id), true);
  assert.throws(
    () => graphInternals.insertGraphEdge(
      eventNode.node_id,
      sessionNode.node_id,
      "invalid_back_edge",
      sessionId,
      0,
      new Date(0).toISOString(),
    ),
    /cycle/u,
  );

  storage.close();
});

test("pages session retrieval for very long sessions", () => {
  const storage = createStorage({ home: tempHome() });
  const sessionId = "paged-session";
  const cwd = "/tmp/dag-page";

  for (let index = 0; index < 10; index += 1) {
    ingest(storage, "UserPromptSubmit", {
      session_id: sessionId,
      turn_id: `turn-${index}`,
      cwd,
      prompt: `page event ${index}`,
    }, `2026-06-09T12:00:${String(index).padStart(2, "0")}.000Z`);
  }

  const first = storage.getSession(sessionId, { limit: 4 });
  assert.equal(first.events.length, 4);
  assert.equal(first.events[0].payload.prompt, "page event 0");
  assert.equal(first.next_cursor, "4");

  const second = storage.getSession(sessionId, { limit: 4, cursor: first.next_cursor });
  assert.equal(second.events.length, 4);
  assert.equal(second.events[0].payload.prompt, "page event 4");
  assert.equal(second.next_cursor, "8");

  storage.close();
});

test("packs old matching events from long sessions instead of only the recent tail", () => {
  const storage = createStorage({ home: tempHome() });
  const sessionId = "long-session";
  const cwd = "/tmp/dag-long";

  for (let index = 0; index < 80; index += 1) {
    ingest(storage, "UserPromptSubmit", {
      session_id: sessionId,
      turn_id: `turn-${index}`,
      cwd,
      prompt: index === 3 ? "needle-old-event architecture decision" : `filler event ${index}`,
    }, new Date(Date.UTC(2026, 5, 9, 12, 0, index)).toISOString());
  }

  const packed = storage.packContext({
    query: "needle-old-event",
    cwd,
    budgetTokens: 200,
  });

  assert.match(packed.markdown, /needle-old-event architecture decision/u);
  assert.equal(packed.sources.some((source) => source.kind === "event"), true);
  assert.ok(packed.estimated_tokens <= 200);

  storage.close();
});

test("packs direct query matches before adjacent context under tight budgets", () => {
  const storage = createStorage({ home: tempHome() });
  const sessionId = "small-budget-session";
  const cwd = "/tmp/dag-small-budget";

  ingest(storage, "SessionStart", {
    session_id: sessionId,
    cwd,
    message: "adjacent context that should not crowd out the direct match",
  }, "2026-06-09T12:00:00.000Z");
  ingest(storage, "UserPromptSubmit", {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd,
    prompt: "tiny-budget-needle direct search match",
  }, "2026-06-09T12:00:01.000Z");

  const packed = storage.packContext({
    query: "tiny-budget-needle",
    cwd,
    budgetTokens: 120,
  });

  assert.match(packed.markdown, /tiny-budget-needle direct search match/u);
  const promptIndex = packed.markdown.indexOf("UserPromptSubmit");
  const sessionIndex = packed.markdown.indexOf("SessionStart");
  assert.equal(promptIndex !== -1, true);
  assert.equal(sessionIndex === -1 || promptIndex < sessionIndex, true);

  storage.close();
});

test("pack context ignores LCM retrieval tool self-references", () => {
  const storage = createStorage({ home: tempHome() });
  const sessionId = "self-ref-session";
  const cwd = "/tmp/self-ref";

  ingest(storage, "UserPromptSubmit", {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd,
    prompt: "needle-public-readme prompt from the user",
  }, "2026-06-09T12:00:00.000Z");
  ingest(storage, "PreToolUse", {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd,
    tool_name: "mcp__codex_lcm__lcm_pack_context",
    tool_input: {
      query: "needle-public-readme prompt from the user",
      budgetTokens: 600,
    },
    tool_use_id: "lcm-tool-call",
  }, "2026-06-09T12:00:01.000Z");

  const packed = storage.packContext({
    cwd,
    query: "needle-public-readme prompt from the user",
    budgetTokens: 400,
  });

  assert.match(packed.markdown, /needle-public-readme prompt from the user/u);
  assert.doesNotMatch(packed.markdown, /mcp__codex_lcm__lcm_pack_context/u);

  storage.close();
});

test("pack context falls back to global matches when cwd-scoped search is empty", () => {
  const storage = createStorage({ home: tempHome() });

  ingest(storage, "UserPromptSubmit", {
    session_id: "lcm-meta-session",
    turn_id: "turn-1",
    cwd: "/Users/djr/Projects/codex-lcm",
    prompt: "codex-lcm retrieval quality plumbing intelligence layer assessment",
  }, "2026-06-09T12:00:00.000Z");

  const packed = storage.packContext({
    cwd: "/Users/djr",
    query: "codex-lcm retrieval quality plumbing intelligence layer",
    budgetTokens: 300,
  });

  assert.match(packed.markdown, /codex-lcm retrieval quality plumbing intelligence/u);
  assert.equal(packed.sources.some((source) => source.kind === "event" && source.session_id === "lcm-meta-session"), true);

  storage.close();
});

test("pack context ranks matching user prompts before matching tool chatter", () => {
  const storage = createStorage({ home: tempHome() });
  const sessionId = "rank-session";
  const cwd = "/tmp/rank";

  ingest(storage, "UserPromptSubmit", {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd,
    prompt: `rank-needle user decision about LCM retrieval quality ${"background ".repeat(10)}`,
  }, "2026-06-09T12:00:00.000Z");
  ingest(storage, "PostToolUse", {
    session_id: sessionId,
    turn_id: "turn-1",
    cwd,
    tool_name: "Bash",
    tool_input: {
      command: "echo rank-needle",
    },
    tool_response: "rank-needle retrieval quality ".repeat(8),
    tool_use_id: "tool-rank",
  }, "2026-06-09T12:00:01.000Z");

  const packed = storage.packContext({
    cwd,
    query: "rank-needle retrieval quality",
    budgetTokens: 500,
  });

  const promptIndex = packed.markdown.indexOf("UserPromptSubmit");
  const toolIndex = packed.markdown.indexOf("PostToolUse");
  assert.notEqual(promptIndex, -1);
  assert.notEqual(toolIndex, -1);
  assert.equal(promptIndex < toolIndex, true);

  storage.close();
});

test("pack context supplements scoped tool-only hits with global high-signal matches", () => {
  const storage = createStorage({ home: tempHome() });

  ingest(storage, "PostToolUse", {
    session_id: "tool-only-session",
    cwd: "/Users/djr",
    tool_name: "Bash",
    tool_input: {
      command: "sed hooks.json",
    },
    tool_response: "codex-lcm retrieval quality plumbing intelligence layer ".repeat(6),
    tool_use_id: "tool-only",
  }, "2026-06-09T12:00:00.000Z");
  ingest(storage, "UserPromptSubmit", {
    session_id: "global-high-signal-session",
    turn_id: "turn-1",
    cwd: "/Users/djr/Projects/codex-lcm",
    prompt: "codex-lcm retrieval quality plumbing intelligence layer user evaluation",
  }, "2026-06-09T12:00:01.000Z");

  const packed = storage.packContext({
    cwd: "/Users/djr",
    query: "codex-lcm retrieval quality plumbing intelligence layer",
    budgetTokens: 500,
  });

  const promptIndex = packed.markdown.indexOf("UserPromptSubmit");
  const toolIndex = packed.markdown.indexOf("PostToolUse");
  assert.notEqual(promptIndex, -1);
  assert.notEqual(toolIndex, -1);
  assert.equal(promptIndex < toolIndex, true);

  storage.close();
});

test("migrates pre-DAG SQLite indexes before creating graph indexes", () => {
  const home = tempHome();
  fs.mkdirSync(home, { recursive: true });
  const events = ["SessionStart", "UserPromptSubmit", "Stop"].map((hookEvent, index) => normalizeHookEvent({
    hookEvent,
    rawInput: JSON.stringify({
      session_id: "legacy-session",
      turn_id: index === 0 ? undefined : "legacy-turn",
      cwd: "/tmp/legacy",
      prompt: `legacy migration event ${index}`,
    }),
    env: {},
    now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
  }));
  fs.writeFileSync(path.join(home, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const db = new DatabaseSync(path.join(home, "index.sqlite"));
  db.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repo_root TEXT,
      git_branch TEXT,
      event_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      hook_event TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repo_root TEXT,
      git_branch TEXT,
      text TEXT NOT NULL,
      raw_json TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE event_fts USING fts5(
      event_id UNINDEXED,
      session_id,
      cwd,
      repo_root,
      hook_event,
      content
    );
  `);
  db.prepare(`
    INSERT INTO sessions (session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count)
    VALUES (?1, ?2, ?3, ?4, NULL, NULL, ?5)
  `).run("legacy-session", events[0].timestamp, events[2].timestamp, "/tmp/legacy", events.length);
  for (const event of events) {
    db.prepare(`
      INSERT INTO events (event_id, session_id, timestamp, hook_event, cwd, repo_root, git_branch, text, raw_json)
      VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, ?6, ?7)
    `).run(event.event_id, event.session_id, event.timestamp, event.hook_event, event.cwd, JSON.stringify(event.payload), JSON.stringify(event));
  }
  db.close();

  const storage = createStorage({ home });
  const health = storage.health();
  assert.equal(health.index_available, true);
  assert.equal(health.graph_node_count !== undefined && health.graph_node_count > 0, true);
  assert.equal(health.graph_edge_count !== undefined && health.graph_edge_count > 0, true);
  assert.equal(storage.getSessionGraph("legacy-session", { limit: 20 }).nodes.some((node) => node.kind === "turn"), true);

  storage.close();
});

function ingest(
  storage: ReturnType<typeof createStorage>,
  hookEvent: string,
  payload: Record<string, unknown>,
  timestamp: string,
): void {
  storage.ingest(normalizeHookEvent({
    hookEvent,
    rawInput: JSON.stringify(payload),
    env: {},
    now: () => new Date(timestamp),
  }));
}
