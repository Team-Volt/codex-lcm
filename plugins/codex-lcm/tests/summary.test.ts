import assert from "node:assert/strict";
import test from "node:test";

import { normalizeHookEvent } from "../src/events.ts";
import {
  buildSessionMemorySummary,
  isSummarySourceEvent,
  queryTermHitCount,
  rankSummaryNodesForContext,
  type SummaryNode,
} from "../src/summary.ts";

test("session summaries keep the first meaningful prompt as the stable title", () => {
  const events = [
    event("UserPromptSubmit", { prompt: "<recommended_plugins>generated bootstrap context</recommended_plugins>" }, 0),
    event("UserPromptSubmit", { prompt: "Fix the database cleanup behavior" }, 1),
    event("UserPromptSubmit", { prompt: "Now add one more unrelated request" }, 2),
  ];

  const summary = buildSessionMemorySummary(events);

  assert.match(summary.title, /Fix the database cleanup behavior/u);
  assert.doesNotMatch(summary.title, /unrelated request/u);
});

test("summary sources exclude silent heartbeats and stop-hook recovery output", () => {
  const heartbeatPrompt = event("UserPromptSubmit", { prompt: "<heartbeat>check state</heartbeat>" }, 0);
  const silentHeartbeat = event("Stop", {
    last_assistant_message: "<heartbeat><decision>DONT_NOTIFY</decision></heartbeat>",
  }, 1);
  const recoveryStop = event("Stop", {
    stop_hook_active: true,
    last_assistant_message: "recovery replay output",
  }, 2);
  const visibleHeartbeat = event("Stop", {
    last_assistant_message: "<heartbeat><decision>NOTIFY</decision><message>needs attention</message></heartbeat>",
  }, 3);

  assert.equal(isSummarySourceEvent(heartbeatPrompt), false);
  assert.equal(isSummarySourceEvent(silentHeartbeat), false);
  assert.equal(isSummarySourceEvent(recoveryStop), false);
  assert.equal(isSummarySourceEvent(visibleHeartbeat), true);
});

test("summary ranking prefers source-rich focused context over a newer thin query echo", () => {
  const focusedDecision = summaryNode({
    node_id: "summary:ranking:d0:focused",
    source_event_ids: Array.from({ length: 8 }, (_, index) => `focused-event-${index}`),
    source_token_count: 880,
    latest_at: "2026-06-09T12:00:00.000Z",
    summary_text: [
      "D0 leaf summary covering 8 high-signal events.",
      "Focus: retrieval ranking source lineage decision",
      "Topics: retrieval, ranking, source, lineage",
      "- retrieval ranking source lineage decision with implementation context",
    ].join("\n"),
  });
  const thinEcho = summaryNode({
    node_id: "summary:ranking:d0:thin-echo",
    source_event_ids: ["thin-event"],
    source_token_count: 40,
    latest_at: "2026-06-12T12:00:00.000Z",
    summary_text: [
      "D0 leaf summary covering 1 high-signal event.",
      "Focus: retrieval ranking source lineage status",
      "Topics: retrieval, ranking, source, lineage",
      "- retrieval ranking source lineage status check",
    ].join("\n"),
  });

  const ranked = rankSummaryNodesForContext([thinEcho, focusedDecision], "retrieval ranking source lineage");

  assert.equal(ranked[0].node_id, focusedDecision.node_id);
});

test("summary ranking prefers direct topic hits over repeated-term spam", () => {
  const direct = summaryNode({
    node_id: "summary:ranking:d0:direct",
    latest_at: "2026-06-09T12:00:00.000Z",
    summary_text: [
      "D0 leaf summary covering 1 high-signal event.",
      "Focus: Keep vendoring support simple.",
      "Topics: vendoring, support",
      "- Keep vendoring support simple.",
    ].join("\n"),
    topics: ["vendoring", "support"],
  });
  const spammy = summaryNode({
    node_id: "summary:ranking:d0:spammy",
    latest_at: "2026-06-12T12:00:00.000Z",
    summary_text: [
      "D0 leaf summary covering 1 high-signal event.",
      "Focus: vendoring vendoring vendoring vendoring status dump",
      "Topics: vendoring, status",
      "- vendoring vendoring vendoring vendoring status dump",
    ].join("\n"),
    topics: ["vendoring", "status"],
  });

  const ranked = rankSummaryNodesForContext([spammy, direct], "vendoring");

  assert.equal(ranked[0].node_id, direct.node_id);
});

test("summary ranking preserves short numeric issue identifiers", () => {
  const olderAdjacent = summaryNode({
    node_id: "summary:ranking:d0:older-adjacent",
    source_event_ids: Array.from({ length: 8 }, (_, index) => `older-event-${index}`),
    source_token_count: 900,
    latest_at: "2026-06-09T12:00:00.000Z",
    summary_text: [
      "D0 leaf summary covering 8 high-signal events.",
      "Focus: Local installation GitHub CI passed with MCP tools exposed.",
      "Topics: local, installation, github, passed, mcp, tools, exposed",
    ].join("\n"),
  });
  const exactIssue = summaryNode({
    node_id: "summary:ranking:d0:exact-issue",
    source_event_ids: ["exact-event"],
    source_token_count: 120,
    latest_at: "2026-06-10T12:00:00.000Z",
    summary_text: [
      "D0 leaf summary covering 1 high-signal event.",
      "Focus: PR #35 local installation GitHub CI passed with MCP tools exposed.",
      "Topics: local, installation, github, passed, mcp, tools, exposed",
    ].join("\n"),
  });

  const ranked = rankSummaryNodesForContext(
    [olderAdjacent, exactIssue],
    "PR 35 local installation GitHub CI passed MCP tools exposed",
  );

  assert.equal(ranked[0].node_id, exactIssue.node_id);
});

test("short numeric query terms require token boundaries", () => {
  assert.equal(queryTermHitCount("PR #35 passed", "35"), 1);
  assert.equal(queryTermHitCount("source event abc35def", "35"), 0);
});

test("embedded numeric title text cannot outrank exact body evidence", () => {
  const embeddedTitle = summaryNode({
    node_id: "summary:ranking:d0:embedded-title",
    summary_text: [
      "D0 leaf summary covering 1 high-signal event.",
      "Focus: abc35def alpha status",
      "Topics: alpha, status",
    ].join("\n"),
  });
  const exactBody = summaryNode({
    node_id: "summary:ranking:d0:exact-body",
    summary_text: [
      "D0 leaf summary covering 1 high-signal event.",
      "Focus: alpha status",
      "Topics: alpha, status",
      "- PR #35 exact evidence",
    ].join("\n"),
  });

  const ranked = rankSummaryNodesForContext([embeddedTitle, exactBody], "35 alpha");

  assert.equal(ranked[0].node_id, exactBody.node_id);
});

function summaryNode(overrides: Partial<SummaryNode>): SummaryNode {
  return {
    node_id: "summary:ranking:d0:base",
    session_id: "ranking-session",
    depth: 0,
    summary_text: "",
    token_count: 10,
    source_token_count: 10,
    source_type: "events",
    source_ids: ["event"],
    source_event_ids: ["event"],
    earliest_at: "2026-06-09T12:00:00.000Z",
    latest_at: "2026-06-09T12:00:00.000Z",
    created_at: "2026-06-09T12:00:00.000Z",
    cwd: "/tmp/ranking",
    topics: ["retrieval", "ranking", "source", "lineage"],
    ...overrides,
  };
}

function event(hookEvent: string, payload: Record<string, unknown>, second: number) {
  return normalizeHookEvent({
    hookEvent,
    rawInput: JSON.stringify({ session_id: "summary-quality-session", cwd: "/tmp/summary-quality", ...payload }),
    env: {},
    now: () => new Date(Date.UTC(2026, 6, 14, 12, 0, second)),
  });
}
