import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { normalizeHookEvent } from "../src/events.ts";
import { createStorage } from "../src/storage.ts";
import { clearDerivedSummaries, tempHome } from "./helpers.ts";

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
  assert.equal(stats.summary_node_count, 3);
  assert.deepEqual(stats.hook_event_counts, { PreCompact: 1, UserPromptSubmit: 8 });
  assert.deepEqual(stats.summary_nodes_by_depth, { "0": 2, "1": 1 });
  assert.deepEqual(stats.summary_nodes_by_source_type, { events: 2, nodes: 1 });
  assert.equal(stats.sessions_with_summary_nodes, 1);
  assert.equal(stats.max_summary_depth, 1);
  assert.equal(stats.latest_event_at, "2026-06-09T12:00:08.000Z");
  assert.equal(stats.latest_summary_node_at, "2026-06-09T12:00:08.000Z");
  assert.equal(stats.graph_nodes_by_kind.event, 9);
  assert.equal(stats.graph_nodes_by_kind.session, 1);
  assert.equal(stats.graph_edges_by_kind.contains, 9);
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
