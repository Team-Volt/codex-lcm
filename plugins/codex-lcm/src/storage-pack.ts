import type { DatabaseSync } from "node:sqlite";

import { decodePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";
import { readRawEvents } from "./raw-log.ts";
import { getLatestCheckpoint } from "./storage-graph.ts";
import { recordValue } from "./storage-rows.ts";
import { STORED_EVENT_JSON_SQL } from "./stored-event.ts";
import {
  bestMatchSnippet,
  compactWhitespace,
  searchStoredSessions,
  truncateSnippet,
} from "./storage-search.ts";
import {
  getCurrentStoredSession,
  isCodexLcmToolEvent,
  resolveStoredSessionIdentifier,
} from "./storage-sessions.ts";
import {
  getSessionMemorySummary,
  getSummaryNode,
  getSummaryNodesForSession,
  getSummaryNodeSourceEvents,
  getTopSummaryNodesForSession,
  searchSummaryNodes,
} from "./storage-summaries.ts";
import type { GraphNode, PackedContext, PackContextArgs } from "./storage-types.ts";
import {
  HISTORICAL_SOURCE_TEXT_NOTICE,
  SUMMARY_NODE_PACK_LIMIT,
  eventSignalText,
  isSummarySourceEvent,
  matchesQueryText,
  queryTermHitCount,
  quoteHistoricalText,
  rankSummaryNodesForContext,
  sessionSummaryToMarkdown,
  summaryNodeExpansionToMarkdown,
  summaryNodeSearchText,
  summaryNodeToCompactMarkdown,
  summaryNodeToMarkdown,
  summarySearchText,
  toFtsQueries,
  type SessionMemorySummary,
  type SummaryNode,
} from "./summary.ts";

const SUMMARY_SOURCE_HOOKS = "('UserPromptSubmit', 'Note', 'Stop', 'PreCompact', 'PostCompact')";

function rankContextEvents(events: NormalizedEvent[], query: string): NormalizedEvent[] {
  const phrase = compactWhitespace(query).toLowerCase();
  return [...events].sort((a, b) => {
    const aText = eventSignalText(a);
    const bText = eventSignalText(b);
    const exactDifference = Number(bText.toLowerCase().includes(phrase)) - Number(aText.toLowerCase().includes(phrase));
    return exactDifference ||
      queryTermHitCount(bText, query) - queryTermHitCount(aText, query) ||
      b.timestamp.localeCompare(a.timestamp) ||
      b.event_id.localeCompare(a.event_id);
  });
}

function contextEventToMarkdown(event: NormalizedEvent, query: string, heading: string): string {
  const signal = eventSignalText(event);
  if (signal.length === 0) return "";
  const snippet = query.length > 0 ? bestMatchSnippet(signal, query, 280) : truncateSnippet(signal, 280);
  return [
    `## ${event.timestamp} ${heading}`,
    `session: ${event.session_id}`,
    `event: ${event.event_id}`,
    HISTORICAL_SOURCE_TEXT_NOTICE,
    quoteHistoricalText(snippet),
    `hook: ${event.hook_event}`,
    "",
  ].join("\n");
}

function checkpointToMarkdown(node: GraphNode): string {
  return [
    `## ${node.timestamp} Checkpoint`,
    `session: ${node.session_id}`,
    `cwd: ${node.cwd}`,
    JSON.stringify(node.metadata),
    "",
  ].join("\n");
}

function searchContextEvents(db: DatabaseSync | undefined, rawLogPath: string, args: {
  query: string;
  cwd?: string;
  sessionIds?: string[];
  limit: number;
}): NormalizedEvent[] {
  const sessionIds = [...new Set(args.sessionIds?.filter(Boolean) ?? [])];
  const sessionFilter = sessionIds.length > 0 ? new Set(sessionIds) : undefined;
  if (!db) {
    return rankContextEvents(readRawEvents(rawLogPath)
      .filter(isSummarySourceEvent)
      .filter((event) => !isCodexLcmToolEvent(event))
      .filter((event) => !args.cwd || event.cwd === args.cwd)
      .filter((event) => !sessionFilter || sessionFilter.has(event.session_id))
      .filter((event) => matchesQueryText(eventSignalText(event), args.query)), args.query)
      .slice(0, args.limit);
  }

  const sessionClause = sessionIds.length > 0
    ? `AND e.session_id IN (${sessionIds.map((_, index) => `?${index + 3}`).join(", ")})`
    : "";
  const limitParameter = sessionIds.length + 3;
  const statement = db.prepare(`
    SELECT lcm_raw_json(e.raw_json, e.segment_id, e.raw_offset, e.raw_length) AS raw_json
    FROM event_fts f
    JOIN events e ON e.event_id = f.event_id
    WHERE event_fts MATCH ?1
      AND (?2 IS NULL OR e.cwd = ?2)
      AND e.hook_event IN ${SUMMARY_SOURCE_HOOKS}
      ${sessionClause}
    ORDER BY bm25(event_fts) ASC, e.timestamp DESC
    LIMIT ?${limitParameter}
  `);
  let rows: unknown[] = [];
  for (const ftsQuery of toFtsQueries(args.query)) {
    rows = statement.all(ftsQuery, args.cwd ?? null, ...sessionIds, Math.max(args.limit * 10, 50));
    if (rows.length > 0) break;
  }
  return rankContextEvents(rows
    .map((row) => decodePersistedEvent(String(recordValue(row).raw_json)))
    .filter(isSummarySourceEvent)
    .filter((event) => !isCodexLcmToolEvent(event)), args.query)
    .slice(0, args.limit);
}

function getRecentContextEvents(db: DatabaseSync | undefined, rawLogPath: string, sessionId: string, limit: number): NormalizedEvent[] {
  if (!db) {
    return readRawEvents(rawLogPath)
      .filter((event) => event.session_id === sessionId)
      .filter(isSummarySourceEvent)
      .filter((event) => !isCodexLcmToolEvent(event))
      .slice(-limit)
      .reverse();
  }
  return db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
    WHERE session_id = ?1
      AND hook_event IN ${SUMMARY_SOURCE_HOOKS}
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ?2
  `).all(sessionId, limit)
    .map((row) => decodePersistedEvent(String(recordValue(row).raw_json)))
    .filter((event) => !isCodexLcmToolEvent(event));
}

export function packContext(db: DatabaseSync | undefined, rawLogPath: string, args: PackContextArgs = {}): PackedContext {
  const budgetTokens = Math.max(16, args.budgetTokens ?? 1200);
  const budgetChars = budgetTokens * 4;
  const summaryCandidates = new Map<string, SessionMemorySummary>();
  const checkpointCandidates = new Map<string, GraphNode>();
  const summaryNodeCandidates = new Map<string, SummaryNode>();
  const exactEventCandidates = new Map<string, NormalizedEvent>();
  const recentEventCandidates = new Map<string, NormalizedEvent>();
  const query = args.query?.trim() ?? "";
  const candidateSessionIds = new Set(args.sessionIds ?? []);
  const explicitSessionIds = args.sessionIds ?? [];
  const currentThreadId = !explicitSessionIds.length ? args.currentThreadId?.trim() : undefined;
  const currentSessionId = currentThreadId ? resolveStoredSessionIdentifier(db, rawLogPath, currentThreadId) : undefined;
  const queryTermCount = query.length > 0 ? queryTermHitCount(query, query) : 0;

  const addSummaryNode = (node: SummaryNode) => {
    if (query.length > 0 && queryTermHitCount(summaryNodeSearchText(node), query) === 0) return;
    summaryNodeCandidates.set(node.node_id, node);
    candidateSessionIds.add(node.session_id);
  };

  const addRankedSessionNodes = (sessionId: string, limit: number): number => {
    const nodes = query.length > 0
      ? rankSummaryNodesForContext(getSummaryNodesForSession(db, sessionId, 2_000), query)
        .filter((node) => queryTermHitCount(summaryNodeSearchText(node), query) > 0)
        .slice(0, limit)
      : getTopSummaryNodesForSession(db, sessionId, limit);
    for (const node of nodes) addSummaryNode(node);
    return nodes.length;
  };

  const addSessionIfSummaryMatches = (sessionId: string): void => {
    if (query.length === 0) {
      candidateSessionIds.add(sessionId);
      return;
    }
    const summary = getSessionMemorySummary(db, rawLogPath, sessionId);
    if (summary && queryTermHitCount(summarySearchText(summary), query) > 0) {
      candidateSessionIds.add(sessionId);
    }
  };

  if (query.length > 0) {
    let events = searchContextEvents(db, rawLogPath, {
      query,
      cwd: args.cwd,
      sessionIds: explicitSessionIds,
      limit: 3,
    });
    if (events.length === 0 && args.cwd && explicitSessionIds.length === 0) {
      events = searchContextEvents(db, rawLogPath, { query, limit: 3 });
    }
    for (const event of events) {
      exactEventCandidates.set(event.event_id, event);
      candidateSessionIds.add(event.session_id);
    }
  }

  if (currentSessionId) {
    const added = addRankedSessionNodes(currentSessionId, 3);
    if (added === 0) addSessionIfSummaryMatches(currentSessionId);
  }

  if (query.length > 0) {
    let nodes = searchSummaryNodes(db, {
      query,
      cwd: args.cwd,
      sessionIds: explicitSessionIds,
      limit: SUMMARY_NODE_PACK_LIMIT,
    });
    if (nodes.length === 0 && args.cwd && !explicitSessionIds.length) {
      nodes = searchSummaryNodes(db, { query, limit: SUMMARY_NODE_PACK_LIMIT });
    }
    for (const node of nodes) addSummaryNode(node);

    const bestSummaryHitCount = [...summaryNodeCandidates.values()].reduce(
      (max, node) => Math.max(max, queryTermHitCount(summaryNodeSearchText(node), query)),
      0,
    );
    const hasWeakScopedMatches = args.cwd && !explicitSessionIds.length && queryTermCount >= 4 && bestSummaryHitCount <= 1;
    if (hasWeakScopedMatches) {
      const sessions = searchStoredSessions(db, rawLogPath, { query, limit: 8 });
      for (const session of sessions) {
        addSessionIfSummaryMatches(session.session_id);
        addRankedSessionNodes(session.session_id, 2);
      }
    }

    if (summaryNodeCandidates.size === 0 && !explicitSessionIds.length) {
      let sessions = searchStoredSessions(db, rawLogPath, { query, cwd: args.cwd, limit: 8 });
      if (sessions.length === 0 && args.cwd) {
        sessions = searchStoredSessions(db, rawLogPath, { query, limit: 8 });
      }
      for (const session of sessions) {
        candidateSessionIds.add(session.session_id);
        addRankedSessionNodes(session.session_id, 2);
      }
    }
  } else {
    if (candidateSessionIds.size === 0) {
      const session = getCurrentStoredSession(db, rawLogPath, { cwd: args.cwd });
      if (session) candidateSessionIds.add(session.session_id);
    }
    for (const sessionId of candidateSessionIds) {
      for (const node of getTopSummaryNodesForSession(db, sessionId, 3)) addSummaryNode(node);
    }
  }

  if (candidateSessionIds.size === 0) {
    let sessions = searchStoredSessions(db, rawLogPath, { query: args.query, cwd: args.cwd, limit: 8 });
    if (sessions.length === 0 && query.length > 0 && args.cwd && !explicitSessionIds.length) {
      sessions = searchStoredSessions(db, rawLogPath, { query: args.query, limit: 8 });
    }
    for (const session of sessions) candidateSessionIds.add(session.session_id);
  }

  const recentSessionIds = currentSessionId
    ? [currentSessionId]
    : explicitSessionIds.length > 0
      ? explicitSessionIds
      : query.length === 0
        ? [...candidateSessionIds].slice(0, 1)
        : [];
  for (const sessionId of recentSessionIds) {
    for (const event of getRecentContextEvents(db, rawLogPath, sessionId, 2)) {
      if (!exactEventCandidates.has(event.event_id)) recentEventCandidates.set(event.event_id, event);
      if (recentEventCandidates.size >= 4) break;
    }
    if (recentEventCandidates.size >= 4) break;
  }

  for (const sessionId of candidateSessionIds) {
    const summary = getSessionMemorySummary(db, rawLogPath, sessionId);
    if (summary) summaryCandidates.set(sessionId, summary);
    const checkpoint = getLatestCheckpoint(db, sessionId);
    if (checkpoint) checkpointCandidates.set(checkpoint.node_id, checkpoint);
  }

  const lines = ["# Codex LCM Context", ""];
  const sources: PackedContext["sources"] = [];
  let chars = lines.join("\n").length;

  const eventItems = [
    ...rankContextEvents([...exactEventCandidates.values()], query)
      .map((event) => ({ event, text: contextEventToMarkdown(event, query, "Matching Event") })),
    ...[...recentEventCandidates.values()]
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.event_id.localeCompare(a.event_id))
      .map((event) => ({ event, text: contextEventToMarkdown(event, "", "Recent Event") })),
  ].filter(({ text }) => text.length > 0);
  const packedEventIds = new Set(eventItems.map(({ event }) => event.event_id));
  const summaryItems = [...summaryCandidates.values()]
    .sort((a, b) =>
      queryTermHitCount(summarySearchText(b), query) - queryTermHitCount(summarySearchText(a), query) ||
      b.updated_at.localeCompare(a.updated_at))
    .map((summary) => ({ summary, text: sessionSummaryToMarkdown(summary) }));
  const checkpointItems = [...checkpointCandidates.values()]
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    .map((checkpoint) => ({ checkpoint, text: checkpointToMarkdown(checkpoint) }));
  const summaryNodeItems = rankSummaryNodesForContext([...summaryNodeCandidates.values()], query)
    .map((node) => {
      const sourceNodes = node.source_type === "nodes"
        ? node.source_ids.flatMap((nodeId) => getSummaryNode(db, nodeId) ?? []).slice(0, 4)
        : [];
      const sourceEvents = getSummaryNodeSourceEvents(db, node, query)
        .filter((event) => !packedEventIds.has(event.event_id));
      const text = [
        summaryNodeToMarkdown(node),
        summaryNodeExpansionToMarkdown({
          sourceNodes,
          sourceEvents,
        }),
      ].filter(Boolean).join("\n");
      const compactText = summaryNodeToCompactMarkdown(node, { sourceEvents, query });
      return { node, sourceEvents, text, compactText };
    });
  const addEventItems = () => {
    for (const { event, text } of eventItems) {
      const remainingChars = budgetChars - chars;
      if (remainingChars <= 80) continue;
      const outputText = text.length > remainingChars
        ? `${text.slice(0, Math.max(0, remainingChars - 18)).trimEnd()}\n...(truncated)\n`
        : text;
      lines.push(outputText);
      chars += outputText.length;
      sources.push({
        kind: event.hook_event === "Note" ? "note" : "event",
        session_id: event.session_id,
        event_id: event.event_id,
        timestamp: event.timestamp,
      });
    }
  };
  const addCheckpointItems = () => {
    for (const { checkpoint, text } of checkpointItems) {
      if (chars + text.length > budgetChars) continue;
      lines.push(text);
      chars += text.length;
      sources.push({
        kind: "checkpoint",
        session_id: checkpoint.session_id,
        node_id: checkpoint.node_id,
        timestamp: checkpoint.timestamp,
      });
    }
  };

  const addSummaryItems = () => {
    if (query.length > 0 && budgetTokens < 250) return;
    if (query.length > 0 && summaryNodeItems.length > 0 && budgetTokens < 350) return;
    if (query.length > 0 && summaryItems.length > 1 && budgetTokens < 700) return;
    for (const { summary, text } of summaryItems) {
      if (chars + text.length > budgetChars) continue;
      lines.push(text);
      chars += text.length;
      sources.push({
        kind: "summary",
        session_id: summary.session_id,
        event_id: summary.source_event_ids[0],
        timestamp: summary.updated_at,
      });
    }
  };

  const addSummaryNodeItems = () => {
    for (const { node, sourceEvents, text, compactText } of summaryNodeItems) {
      const remainingChars = budgetChars - chars;
      if (remainingChars <= 80) continue;
      const candidateText = text.length <= remainingChars ? text : compactText;
      const outputText = candidateText.length > remainingChars
        ? `${candidateText.slice(0, Math.max(0, remainingChars - 18)).trimEnd()}\n...(truncated)\n`
        : candidateText;
      lines.push(outputText);
      chars += outputText.length;
      sources.push({
        kind: "summary",
        session_id: node.session_id,
        node_id: node.node_id,
        event_id: node.source_event_ids[0],
        timestamp: node.latest_at,
      });
      const note = sourceEvents.find((event) => event.hook_event === "Note");
      if (note) {
        sources.push({
          kind: "note",
          session_id: note.session_id,
          event_id: note.event_id,
          timestamp: note.timestamp,
        });
      }
    }
  };

  addEventItems();
  addSummaryNodeItems();
  addSummaryItems();
  addCheckpointItems();

  return {
    markdown: lines.join("\n"),
    estimated_tokens: Math.ceil(chars / 4),
    sources,
  };
}
