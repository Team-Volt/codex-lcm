import type { DatabaseSync } from "node:sqlite";

import { decodePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";
import type { FileReference } from "./file-refs.ts";
import { overflowReferenceFromEvent, readOverflowContent, type OverflowReference } from "./overflow.ts";
import { readRawEvents } from "./raw-log.ts";
import { recordValue, rowToFileReference } from "./storage-rows.ts";
import { STORED_EVENT_JSON_SQL } from "./stored-event.ts";
import {
  clampLimit,
  positiveInteger,
  searchStoredSessions,
} from "./storage-search.ts";
import {
  getCurrentStoredSession,
  getStoredSessionSummary,
  extractEventMetadata,
} from "./storage-sessions.ts";
import {
  getSessionMemorySummary,
  getSessionSummarySourceEvents,
  getSourceSummaryNodes,
  getSummaryNode,
  getSummaryNodesForSession,
  getSummaryNodeSourceEvents,
  getTopSummaryNodesForSession,
  searchSummaryNodes,
} from "./storage-summaries.ts";
import type {
  ContextPlan,
  ContextPlanState,
  LcmDescription,
  LcmExpansion,
  LcmQueryExpansion,
  QueryExpansionSource,
  RecentContext,
  SearchSessionArgs,
  SessionSummary,
} from "./storage-types.ts";
import {
  HISTORICAL_SOURCE_TEXT_NOTICE,
  SUMMARY_NODE_SOURCE_EVENT_LIMIT,
  estimateTokenCount,
  eventSignalText,
  matchesQueryText,
  queryTermHitCount,
  quoteHistoricalText,
  rankSummaryNodesForContext,
  summaryNodeExpansionToMarkdown,
  summaryNodeSearchText,
  summaryNodeTitle,
  summaryNodeToMarkdown,
  summarySearchText,
  type SessionMemorySummary,
  type SummaryNode,
} from "./summary.ts";

const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 96_000;
const DEFAULT_CONTEXT_PLAN_RECENT_EVENT_LIMIT = 80;


function buildContextPlan(args: {
  session?: SessionSummary;
  modelContextWindow: number;
  autoCompactTokenLimit: number;
  recentEventLimit: number;
  estimatedRecentTokens: number;
  estimatedSummaryTokens: number;
  summaryNodeCount: number;
  latestEventAt: string | null;
}): ContextPlan {
  const estimatedTotalTokens = args.estimatedRecentTokens + args.estimatedSummaryTokens;
  const state = contextPlanState(estimatedTotalTokens, args.autoCompactTokenLimit, args.modelContextWindow);
  const suggestedTools = state === "under_limit" || state === "empty"
    ? ["lcm_context_plan"]
    : ["lcm_context_plan", "lcm_pack_context", "lcm_expand_query"];
  return {
    ...(args.session ? {
      session_id: args.session.session_id,
      cwd: args.session.cwd,
      ...(args.session.repo_root ? { repo_root: args.session.repo_root } : {}),
    } : {}),
    model_context_window: args.modelContextWindow,
    auto_compact_token_limit: args.autoCompactTokenLimit,
    recent_event_limit: args.recentEventLimit,
    estimated_recent_tokens: args.estimatedRecentTokens,
    estimated_summary_tokens: args.estimatedSummaryTokens,
    estimated_total_tokens: estimatedTotalTokens,
    summary_node_count: args.summaryNodeCount,
    latest_event_at: args.latestEventAt,
    state,
    recommendation: contextPlanRecommendation(state, args.summaryNodeCount),
    suggested_tools: suggestedTools,
    can_control_compaction: false,
  };
}

function contextPlanState(estimatedRecentTokens: number, autoCompactTokenLimit: number, modelContextWindow: number): ContextPlanState {
  if (estimatedRecentTokens <= 0) return "empty";
  if (estimatedRecentTokens >= modelContextWindow) return "over_context";
  if (estimatedRecentTokens >= autoCompactTokenLimit) return "over_limit";
  if (estimatedRecentTokens >= Math.floor(autoCompactTokenLimit * 0.8)) return "near_limit";
  return "under_limit";
}

function contextPlanRecommendation(state: ContextPlanState, summaryNodeCount: number): string {
  if (state === "empty") return "No matching session found.";
  if (state === "under_limit") return "No context packing needed yet.";
  if (summaryNodeCount === 0) return "Context pressure is high, but no summary nodes are available yet.";
  if (state === "near_limit") return "Near the soft context limit; use lcm_pack_context for broad recall before continuing.";
  if (state === "over_context") return "Estimated recent context is past the model window; use lcm_pack_context or lcm_expand_query for focused recovery.";
  return "Past the soft context limit; use lcm_pack_context or lcm_expand_query before relying on raw recent context.";
}

function rankQueryExpansionNodes(nodes: SummaryNode[], query: string, overview: boolean): SummaryNode[] {
  const ranked = rankSummaryNodesForContext(nodes, query);
  if (!overview) return ranked;
  return ranked.sort((left, right) =>
    right.depth - left.depth ||
    Number(right.source_type === "nodes") - Number(left.source_type === "nodes") ||
    right.source_ids.length - left.source_ids.length ||
    queryTermHitCount(summaryNodeSearchText(right), query) - queryTermHitCount(summaryNodeSearchText(left), query) ||
    right.latest_at.localeCompare(left.latest_at) ||
    right.node_id.localeCompare(left.node_id));
}

function focusedExcerpt(value: string, query: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const terms = query.toLowerCase().split(/[^a-z0-9_-]+/u).filter((term) => term.length > 0);
  const lowerValue = value.toLowerCase();
  const hit = terms
    .map((term) => lowerValue.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const prefix = hit > 0 ? "..." : "";
  const suffix = hit + maxChars < value.length ? "..." : "";
  const bodyBudget = Math.max(0, maxChars - prefix.length - suffix.length);
  const start = Math.max(0, Math.min(hit, value.length - bodyBudget));
  return `${prefix}${value.slice(start, start + bodyBudget)}${suffix}`;
}

export function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseTimestamp(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${name} must be a valid ISO-8601 timestamp.`);
  return timestamp.toISOString();
}

export function eventSearchText(event: NormalizedEvent): string {
  const metadata = extractEventMetadata(event);
  return [
    event.hook_event,
    event.session_id,
    event.cwd,
    event.repo_root,
    event.git_branch,
    event.tool_name,
    metadata.turn_id,
    metadata.tool_use_id,
    JSON.stringify(event.payload),
  ].filter(Boolean).join("\n");
}


export function getRecentContext(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  args: { sessionId?: string; cwd?: string; repoRoot?: string; limit?: number } = {},
): RecentContext {
  const session = getCurrentStoredSession(db, rawLogPath, {
    sessionId: args.sessionId,
    cwd: args.cwd,
    repoRoot: args.repoRoot,
  });
  if (!session) return { events: [] };
  const limit = clampLimit(args.limit, 20);
  if (!db) {
    const events = readRawEvents(rawLogPath)
      .filter((event) => event.session_id === session.session_id)
      .slice(-limit);
    return { session_id: session.session_id, events };
  }
  const rows = db.prepare(`
    SELECT raw_json FROM (
      SELECT ${STORED_EVENT_JSON_SQL} AS raw_json, timestamp, rowid
      FROM events
      WHERE session_id = ?1
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?2
    )
    ORDER BY timestamp ASC, rowid ASC
  `).all(session.session_id, limit);
  return {
    session_id: session.session_id,
    events: rows.map((row) => decodePersistedEvent(String(recordValue(row).raw_json))),
  };
}

export function getContextPlan(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  args: {
    sessionId?: string;
    cwd?: string;
    repoRoot?: string;
    modelContextWindow?: number;
    autoCompactTokenLimit?: number;
    recentEventLimit?: number;
  } = {},
): ContextPlan {
  const modelContextWindow = positiveInteger(args.modelContextWindow, DEFAULT_MODEL_CONTEXT_WINDOW);
  const autoCompactTokenLimit = Math.min(
    positiveInteger(args.autoCompactTokenLimit, DEFAULT_AUTO_COMPACT_TOKEN_LIMIT),
    modelContextWindow,
  );
  const recentEventLimit = clampLimit(args.recentEventLimit, DEFAULT_CONTEXT_PLAN_RECENT_EVENT_LIMIT, 500);
  const session = getCurrentStoredSession(db, rawLogPath, {
    sessionId: args.sessionId,
    cwd: args.cwd,
    repoRoot: args.repoRoot,
  });
  if (!session) {
    return buildContextPlan({
      modelContextWindow,
      autoCompactTokenLimit,
      recentEventLimit,
      estimatedRecentTokens: 0,
      estimatedSummaryTokens: 0,
      summaryNodeCount: 0,
      latestEventAt: null,
    });
  }

  const events = getContextPlanEvents(db, rawLogPath, session.session_id, recentEventLimit);
  const summaryStats = getContextPlanSummaryStats(db, session.session_id);
  const estimatedRecentTokens = estimateTokenCount(events.map(eventSearchText).join("\n"));
  const latestEventAt = events[events.length - 1]?.timestamp ?? session.last_seen ?? null;

  return buildContextPlan({
    session,
    modelContextWindow,
    autoCompactTokenLimit,
    recentEventLimit,
    estimatedRecentTokens,
    estimatedSummaryTokens: summaryStats.estimatedSummaryTokens,
    summaryNodeCount: summaryStats.summaryNodeCount,
    latestEventAt,
  });
}

export function getFileRefsForSession(db: DatabaseSync | undefined, sessionId: string, limit = 50): FileReference[] {
  if (!db) return [];
  return db.prepare(`
    SELECT file_ref_id, session_id, observed_event_id, timestamp, path, mime_type,
           byte_count, sha256, exploration_summary, metadata_json
    FROM file_refs
    WHERE session_id = ?1
    ORDER BY timestamp ASC, file_ref_id ASC
    LIMIT ?2
  `).all(sessionId, clampLimit(limit, 50, 500)).map(rowToFileReference);
}

export function getFileRef(db: DatabaseSync | undefined, fileRefId: string): FileReference | undefined {
  if (!db) return undefined;
  const row = db.prepare(`
    SELECT file_ref_id, session_id, observed_event_id, timestamp, path, mime_type,
           byte_count, sha256, exploration_summary, metadata_json
    FROM file_refs
    WHERE file_ref_id = ?1
  `).get(fileRefId);
  return row ? rowToFileReference(row) : undefined;
}

export function getOverflowRef(db: DatabaseSync | undefined, rawLogPath: string, fileRefId: string): OverflowReference | undefined {
  if (!fileRefId.startsWith("overflow:")) return undefined;
  const hash = fileRefId.slice("overflow:".length);
  if (!/^[a-f0-9]{64}$/u.test(hash)) return undefined;
  if (!db) {
    return readRawEvents(rawLogPath)
      .map(overflowReferenceFromEvent)
      .find((reference) => reference?.sha256 === hash);
  }
  const rawJson = recordValue(db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json
    FROM events
    WHERE overflow_sha256 = ?1
    ORDER BY timestamp DESC, rowid DESC
    LIMIT 1
  `).get(hash)).raw_json;
  if (typeof rawJson !== "string") return undefined;
  return overflowReferenceFromEvent(decodePersistedEvent(rawJson));
}

export function describeMemory(db: DatabaseSync | undefined, rawLogPath: string, overflowDir: string, args: {
  sessionId?: string;
  nodeId?: string;
  fileId?: string;
  limit?: number;
  offset?: number;
  maxBytes?: number;
}): LcmDescription {
  if (args.fileId) {
    if (args.fileId.startsWith("overflow:")) {
      const reference = getOverflowRef(db, rawLogPath, args.fileId);
      if (!reference) throw new Error(`Overflow reference not found: ${args.fileId}`);
      return {
        target: "overflow_ref",
        overflow_ref: readOverflowContent({
          overflowDir,
          reference,
          offset: args.offset,
          maxBytes: args.maxBytes,
        }),
      };
    }
    const fileRef = getFileRef(db, args.fileId);
    if (!fileRef) throw new Error(`File reference not found: ${args.fileId}`);
    return {
      target: "file_ref",
      file_ref: fileRef,
    };
  }

  if (args.nodeId) {
    const node = findSummaryNode(db, args.nodeId);
    if (!node) throw new Error(`Summary node not found: ${args.nodeId}`);
    return {
      target: "summary_node",
      node,
      source_nodes: sourceSummaryNodes(db, node, args.limit),
      source_event_count: node.source_event_ids.length,
    };
  }

  if (!args.sessionId) throw new Error("sessionId or nodeId is required.");
  const session = getStoredSessionSummary(db, rawLogPath, args.sessionId);
  const summary = getSessionMemorySummary(db, rawLogPath, args.sessionId);
  const summaryNodes = getSummaryNodesForSession(db, args.sessionId, clampLimit(args.limit, 50, 500));
  if (!session && !summary && summaryNodes.length === 0) {
    throw new Error(`Session not found: ${args.sessionId}`);
  }
  return {
    target: "session",
    session,
    summary,
    summary_nodes: summaryNodes,
    file_refs: getFileRefsForSession(db, args.sessionId, clampLimit(args.limit, 50, 500)),
  };
}

export function expandMemory(db: DatabaseSync | undefined, args: { nodeId: string; query?: string; limit?: number }): LcmExpansion {
  const node = findSummaryNode(db, args.nodeId);
  if (!node) throw new Error(`Summary node not found: ${args.nodeId}`);
  const sourceNodes = sourceSummaryNodes(db, node, args.limit);
  const sourceEvents = summaryNodeSourceEvents(db, node, args.query, args.limit);
  const markdown = [
    summaryNodeToMarkdown(node),
    summaryNodeExpansionToMarkdown({
      sourceNodes,
      sourceEvents,
    }),
  ].filter(Boolean).join("\n");
  return {
    target: "summary_node",
    node,
    source_nodes: sourceNodes,
    source_events: sourceEvents,
    markdown,
  };
}

export function expandQuery(db: DatabaseSync | undefined, rawLogPath: string, args: {
  query: string;
  cwd?: string;
  repoRoot?: string;
  sessionIds?: string[];
  budgetTokens?: number;
  limit?: number;
  sourceLimit?: number;
  overview?: boolean;
}): LcmQueryExpansion {
  const query = args.query.trim();
  if (query.length === 0) throw new Error("query must be a non-empty string.");
  const budgetTokens = Math.max(32, args.budgetTokens ?? 2000);
  const budgetChars = budgetTokens * 4;
  const candidateLimit = clampLimit(args.limit, 4, 12);
  const searchLimit = args.overview ? Math.max(candidateLimit * 4, 24) : candidateLimit;
  const sourceLimit = clampLimit(args.sourceLimit, 6, 24);
  const maxNodes = Math.max(candidateLimit * 12, 24);

  let candidates = findSummaryNodes(db, {
    query,
    cwd: args.cwd,
    repoRoot: args.repoRoot,
    sessionIds: args.sessionIds,
    limit: searchLimit,
  });
  if (candidates.length === 0 && args.cwd && !args.sessionIds?.length) {
    candidates = findSummaryNodes(db, {
      query,
      repoRoot: args.repoRoot,
      limit: searchLimit,
    });
  }
  if (candidates.length === 0 && !args.sessionIds?.length) {
    const sessions = searchStoredSessions(db, rawLogPath, {
      query,
      cwd: args.cwd,
      repoRoot: args.repoRoot,
      limit: candidateLimit,
    });
    for (const session of sessions) {
      candidates.push(...topSummaryNodesForSession(db, session.session_id, 1));
    }
  }

  const nodesById = new Map<string, SummaryNode>();
  const eventsById = new Map<string, NormalizedEvent>();
  if (candidates.length === 0 && args.sessionIds?.length) {
    for (const sessionId of args.sessionIds) {
      const summary = getSessionMemorySummary(db, rawLogPath, sessionId);
      if (!summary || (args.cwd && summary.cwd !== args.cwd) || (args.repoRoot && summary.repo_root !== args.repoRoot)) continue;
      if (!matchesQueryText(summarySearchText(summary), query)) continue;
      candidates.push(...topSummaryNodesForSession(db, sessionId, 1));
      for (const event of sessionSummarySourceEvents(db, summary, query, sourceLimit)) {
        eventsById.set(event.event_id, event);
      }
    }
  }
  const visit = (node: SummaryNode) => {
    if (nodesById.has(node.node_id) || nodesById.size >= maxNodes) return;
    nodesById.set(node.node_id, node);
    for (const event of summaryNodeSourceEvents(db, node, query, sourceLimit)) {
      eventsById.set(event.event_id, event);
    }
    if (node.source_type !== "nodes") return;
    const sourceNodes = rankQueryExpansionNodes(sourceSummaryNodes(db, node, sourceLimit), query, args.overview === true);
    for (const sourceNode of sourceNodes) {
      visit(sourceNode);
      if (nodesById.size >= maxNodes) break;
    }
  };
  for (const candidate of rankQueryExpansionNodes(candidates, query, args.overview === true).slice(0, candidateLimit)) visit(candidate);

  const nodes = rankQueryExpansionNodes([...nodesById.values()], query, args.overview === true);
  const events = [...eventsById.values()].sort((a, b) =>
    queryTermHitCount(eventSignalText(b), query) - queryTermHitCount(eventSignalText(a), query) ||
    a.timestamp.localeCompare(b.timestamp) ||
    a.event_id.localeCompare(b.event_id));
  const sources: QueryExpansionSource[] = [
    ...nodes.map((node) => ({
      kind: "summary" as const,
      session_id: node.session_id,
      node_id: node.node_id,
      timestamp: node.latest_at,
      depth: node.depth,
    })),
    ...events.map((event) => ({
      kind: "event" as const,
      session_id: event.session_id,
      event_id: event.event_id,
      timestamp: event.timestamp,
      hook_event: event.hook_event,
    })),
  ];

  const lines = [
    "# Codex LCM Recursive Evidence",
    "",
    `query: ${query}`,
    "",
  ];
  let chars = lines.join("\n").length;
  let truncated = false;
  const addBlock = (text: string): boolean => {
    if (chars + text.length > budgetChars) {
      truncated = true;
      return false;
    }
    lines.push(text);
    chars += text.length;
    return true;
  };
  const addFocusedEventFallback = (event: NormalizedEvent): void => {
    let prefix = [
      "### Focused Source Events",
      `- ${event.timestamp} ${event.hook_event} ${event.event_id.slice(0, 12)}:`,
      `  ${HISTORICAL_SOURCE_TEXT_NOTICE}`,
      "",
    ].join("\n");
    const suffix = "\n";
    let available = budgetChars - chars - prefix.length - suffix.length;
    if (available <= 0) {
      prefix = "### Focused Source Events\n- ";
      available = budgetChars - chars - prefix.length - suffix.length;
    }
    if (available <= 0) {
      lines.push("Budget too small to include evidence.\n");
      chars += "Budget too small to include evidence.\n".length;
      truncated = true;
      return;
    }
    const signal = quoteHistoricalText(focusedExcerpt(eventSignalText(event), query, Math.max(0, available - 4)), "  ");
    lines.push(`${prefix}${signal}${suffix}`);
    chars += prefix.length + signal.length + suffix.length;
    truncated = true;
  };

  if (events.length > 0) {
    const eventLines = ["### Focused Source Events"];
    for (const event of events.slice(0, sourceLimit)) {
      const signal = eventSignalText(event);
      if (signal.length === 0) continue;
      eventLines.push(`- ${event.timestamp} ${event.hook_event} ${event.event_id.slice(0, 12)}:`);
      eventLines.push(`  ${HISTORICAL_SOURCE_TEXT_NOTICE}`);
      eventLines.push(quoteHistoricalText(signal, "  "));
    }
    eventLines.push("");
    if (!addBlock(eventLines.join("\n"))) addFocusedEventFallback(events[0]);
  }

  if (nodes.length === 0 && events.length === 0) {
    addBlock("No matching evidence found.\n");
  }

  for (const node of nodes) {
    if (!addBlock(summaryNodeToMarkdown(node))) {
      const compact = [
        `## Summary Node d${node.depth}`,
        `node: ${node.node_id}`,
        `session: ${node.session_id}`,
        `Focus: ${summaryNodeTitle(node)}`,
        "",
      ].join("\n");
      addBlock(compact);
    }
  }

  const markdown = lines.join("\n");

  return {
    query,
    markdown,
    estimated_tokens: estimateTokenCount(markdown),
    truncated,
    nodes,
    events,
    sources,
  };
}

function topSummaryNodesForSession(db: DatabaseSync | undefined, sessionId: string, limit = 3): SummaryNode[] {
  return getTopSummaryNodesForSession(db, sessionId, limit);
}

function findSummaryNodes(db: DatabaseSync | undefined, args: SearchSessionArgs & { sessionIds?: string[] }): SummaryNode[] {
  return searchSummaryNodes(db, args);
}

function findSummaryNode(db: DatabaseSync | undefined, nodeId: string): SummaryNode | undefined {
  return getSummaryNode(db, nodeId);
}

function sourceSummaryNodes(db: DatabaseSync | undefined, node: SummaryNode, limit = 4): SummaryNode[] {
  return getSourceSummaryNodes(db, node, limit);
}

function summaryNodeSourceEvents(
  db: DatabaseSync | undefined,
  node: SummaryNode,
  query = "",
  limit = SUMMARY_NODE_SOURCE_EVENT_LIMIT,
): NormalizedEvent[] {
  return getSummaryNodeSourceEvents(db, node, query, limit);
}

function sessionSummarySourceEvents(
  db: DatabaseSync | undefined,
  summary: SessionMemorySummary,
  query: string,
  limit: number,
): NormalizedEvent[] {
  return getSessionSummarySourceEvents(db, summary, query, limit);
}

function getContextPlanEvents(db: DatabaseSync | undefined, rawLogPath: string, sessionId: string, limit: number): NormalizedEvent[] {
  if (!db) {
    return readRawEvents(rawLogPath)
      .filter((event) => event.session_id === sessionId)
      .slice(-limit);
  }
  const rows = db.prepare(`
    SELECT raw_json FROM (
      SELECT ${STORED_EVENT_JSON_SQL} AS raw_json, timestamp, rowid
      FROM events
      WHERE session_id = ?1
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?2
    )
    ORDER BY timestamp ASC, rowid ASC
  `).all(sessionId, limit);
  return rows.map((row) => decodePersistedEvent(String(recordValue(row).raw_json)));
}

function getContextPlanSummaryStats(db: DatabaseSync | undefined, sessionId: string): { summaryNodeCount: number; estimatedSummaryTokens: number } {
  if (!db) return { summaryNodeCount: 0, estimatedSummaryTokens: 0 };
  const row = recordValue(db.prepare(`
    SELECT COUNT(*) AS summary_node_count, COALESCE(SUM(token_count), 0) AS estimated_summary_tokens
    FROM summary_nodes
    WHERE session_id = ?1
  `).get(sessionId));
  return {
    summaryNodeCount: Number(row.summary_node_count ?? 0),
    estimatedSummaryTokens: Number(row.estimated_summary_tokens ?? 0),
  };
}
