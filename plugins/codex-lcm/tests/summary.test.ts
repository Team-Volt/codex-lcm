import assert from "node:assert/strict";
import test from "node:test";

import { rankSummaryNodesForContext, type SummaryNode } from "../src/summary.ts";

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
