import type { DatabaseSync } from "node:sqlite";

import { decodePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";
import { readRawEvents } from "./raw-log.ts";
import { isRecord, recordValue, rowToSessionSummary } from "./storage-rows.ts";
import { STORED_EVENT_JSON_SQL } from "./stored-event.ts";
import type {
  Health,
  LcmStats,
  ListSessionsArgs,
  SessionDetail,
  SessionListSummary,
  SessionPage,
  SessionSummary,
  UsageReport,
} from "./storage-types.ts";
import { buildSessionMemorySummary, eventSignalText, isGeneratedSuggestionEvent, isSummarySourceEvent, type SessionMemorySummary } from "./summary.ts";

export function sortedSessionIds(sessionIds: Iterable<string>): string[] {
  return Array.from(new Set(sessionIds)).sort((left, right) => left.localeCompare(right));
}

function sessionListSummary(summary: SessionMemorySummary): SessionListSummary {
  return {
    updated_at: summary.updated_at,
    title: summary.title,
    overview: summary.overview,
    topics: summary.topics,
    key_prompts: summary.key_prompts,
    outcomes: summary.outcomes,
    source_event_count: summary.source_event_ids.length,
  };
}

function sessionsWithDescendants(allSessions: SessionSummary[], roots: SessionSummary[]): SessionSummary[] {
  const byParent = new Map<string, SessionSummary[]>();
  for (const session of allSessions) {
    if (!session.parent_session_id) continue;
    const children = byParent.get(session.parent_session_id) ?? [];
    children.push(session);
    byParent.set(session.parent_session_id, children);
  }
  const selected = new Map<string, SessionSummary>();
  const queue = [...roots];
  while (queue.length > 0) {
    const session = queue.shift();
    if (!session || selected.has(session.session_id)) continue;
    selected.set(session.session_id, session);
    queue.push(...(byParent.get(session.session_id) ?? []));
  }
  return [...selected.values()];
}

export function summarizeSessions(events: NormalizedEvent[]): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();
  for (const event of events) {
    const metadata = extractSessionMetadata(event);
    const existing = sessions.get(event.session_id);
    if (!existing) {
      sessions.set(event.session_id, {
        session_id: event.session_id,
        first_seen: event.timestamp,
        last_seen: event.timestamp,
        cwd: event.cwd,
        ...(event.repo_root ? { repo_root: event.repo_root } : {}),
        ...(event.git_branch ? { git_branch: event.git_branch } : {}),
        event_count: 1,
        match_count: 1,
        ...metadata,
      });
      continue;
    }
    existing.first_seen = event.timestamp < existing.first_seen ? event.timestamp : existing.first_seen;
    existing.last_seen = event.timestamp > existing.last_seen ? event.timestamp : existing.last_seen;
    existing.cwd = event.cwd;
    existing.repo_root = event.repo_root ?? existing.repo_root;
    existing.git_branch = event.git_branch ?? existing.git_branch;
    existing.event_count += 1;
    existing.match_count = (existing.match_count ?? 0) + 1;
    existing.parent_session_id = metadata.parent_session_id ?? existing.parent_session_id;
    existing.agent_role = metadata.agent_role ?? existing.agent_role;
    existing.agent_nickname = metadata.agent_nickname ?? existing.agent_nickname;
    existing.model = metadata.model ?? existing.model;
    existing.reasoning_effort = metadata.reasoning_effort ?? existing.reasoning_effort;
    existing.total_input_tokens = maxOptional(existing.total_input_tokens, metadata.total_input_tokens);
    existing.cached_input_tokens = maxOptional(existing.cached_input_tokens, metadata.cached_input_tokens);
    existing.output_tokens = maxOptional(existing.output_tokens, metadata.output_tokens);
    existing.reasoning_output_tokens = maxOptional(existing.reasoning_output_tokens, metadata.reasoning_output_tokens);
    existing.total_tokens = maxOptional(existing.total_tokens, metadata.total_tokens);
  }
  return [...sessions.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

export function extractEventMetadata(event: NormalizedEvent): { turn_id?: string; tool_use_id?: string } {
  return {
    turn_id: stringField(event.payload.turn_id) || stringField(event.payload.turnId),
    tool_use_id: stringField(event.payload.tool_use_id) || stringField(event.payload.toolUseId),
  };
}

export function extractSessionMetadata(event: NormalizedEvent): Partial<SessionSummary> {
  const usage = recordField(event.payload.usage);
  const importedMetadata = recordField(event.payload.metadata);
  const inferredParentId = stringField(event.payload.parent_session_id) ||
    parentSessionId(importedMetadata) ||
    delegatedParentSessionId(event);
  return {
    ...(inferredParentId ? { parent_session_id: inferredParentId } : {}),
    ...(stringField(event.payload.agent_role) || stringField(importedMetadata?.agent_role)
      ? { agent_role: stringField(event.payload.agent_role) || stringField(importedMetadata?.agent_role) }
      : {}),
    ...(stringField(event.payload.agent_nickname) || stringField(importedMetadata?.agent_nickname)
      ? { agent_nickname: stringField(event.payload.agent_nickname) || stringField(importedMetadata?.agent_nickname) }
      : {}),
    ...(stringField(event.payload.model) ? { model: stringField(event.payload.model) } : {}),
    ...(stringField(event.payload.reasoning_effort) ? { reasoning_effort: stringField(event.payload.reasoning_effort) } : {}),
    ...(numberField(usage?.input_token_count) !== undefined ? { total_input_tokens: numberField(usage?.input_token_count) } : {}),
    ...(numberField(usage?.cached_input_token_count) !== undefined
      ? { cached_input_tokens: numberField(usage?.cached_input_token_count) }
      : {}),
    ...(numberField(usage?.output_token_count) !== undefined ? { output_tokens: numberField(usage?.output_token_count) } : {}),
    ...(numberField(usage?.reasoning_output_token_count) !== undefined
      ? { reasoning_output_tokens: numberField(usage?.reasoning_output_token_count) }
      : {}),
    ...(numberField(usage?.total_token_count) !== undefined ? { total_tokens: numberField(usage?.total_token_count) } : {}),
  };
}

function delegatedParentSessionId(event: NormalizedEvent): string | undefined {
  if (event.hook_event !== "UserPromptSubmit") return undefined;
  const prompt = eventSignalText(event).trimStart();
  if (!prompt.startsWith("<codex_delegation>")) return undefined;
  const match = /<source_thread_id>\s*([^<\s]+)\s*<\/source_thread_id>/iu.exec(prompt);
  return stringField(match?.[1]);
}

export function parentSessionId(metadata: Record<string, unknown> | undefined): string | undefined {
  const direct = stringField(metadata?.parent_thread_id);
  if (direct) return direct;
  const source = recordField(metadata?.source);
  const subagent = recordField(source?.subagent);
  return stringField(recordField(subagent?.thread_spawn)?.parent_thread_id);
}

function recordField(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function maxOptional(current: number | undefined, incoming: number | undefined): number | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  return Math.max(current, incoming);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function maxNullable(current: string, incoming: string): string {
  return `CASE WHEN ${incoming} IS NULL THEN ${current} WHEN ${current} IS NULL OR ${incoming} > ${current} THEN ${incoming} ELSE ${current} END`;
}

function usageFromSessions(sessions: SessionSummary[]): UsageReport {
  return {
    totals: sessions.reduce((totals, session) => ({
      sessions: totals.sessions + 1,
      input_tokens: totals.input_tokens + (session.total_input_tokens ?? 0),
      cached_input_tokens: totals.cached_input_tokens + (session.cached_input_tokens ?? 0),
      output_tokens: totals.output_tokens + (session.output_tokens ?? 0),
      reasoning_output_tokens: totals.reasoning_output_tokens + (session.reasoning_output_tokens ?? 0),
      total_tokens: totals.total_tokens + (session.total_tokens ?? 0),
    }), {
      sessions: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    }),
  };
}

function usageReportFromRow(row: Record<string, unknown>): UsageReport {
  return {
    totals: {
      sessions: Number(row.sessions),
      input_tokens: Number(row.input_tokens),
      cached_input_tokens: Number(row.cached_input_tokens),
      output_tokens: Number(row.output_tokens),
      reasoning_output_tokens: Number(row.reasoning_output_tokens),
      total_tokens: Number(row.total_tokens),
    },
  };
}

export function storageStats(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  health: Health,
  graphNodeCounts: Record<string, number>,
  graphEdgeCounts: Record<string, number>,
): LcmStats {
  if (!db) {
    return {
      ...health,
      hook_event_counts: countEventsByHook(readRawEvents(rawLogPath)),
      summary_nodes_by_depth: {},
      summary_nodes_by_source_type: {},
      graph_nodes_by_kind: {},
      graph_edges_by_kind: {},
      sessions_with_session_summary: 0,
      sessions_with_summary_nodes: 0,
      max_summary_depth: null,
      latest_event_at: null,
      latest_summary_node_at: null,
    };
  }

  return {
    ...health,
    hook_event_counts: countMap(db, `
      SELECT hook_event AS key, COUNT(*) AS count
      FROM events
      GROUP BY hook_event
      ORDER BY hook_event
    `),
    summary_nodes_by_depth: countMap(db, `
      SELECT depth AS key, COUNT(*) AS count
      FROM summary_nodes
      GROUP BY depth
      ORDER BY depth
    `),
    summary_nodes_by_source_type: countMap(db, `
      SELECT source_type AS key, COUNT(*) AS count
      FROM summary_nodes
      GROUP BY source_type
      ORDER BY source_type
    `),
    graph_nodes_by_kind: graphNodeCounts,
    graph_edges_by_kind: graphEdgeCounts,
    session_summary_count: scalar(db, "SELECT COUNT(*) AS count FROM session_summaries"),
    sessions_with_session_summary: scalar(db, "SELECT COUNT(DISTINCT session_id) AS count FROM session_summaries"),
    sessions_with_summary_nodes: scalar(db, "SELECT COUNT(DISTINCT session_id) AS count FROM summary_nodes"),
    max_summary_depth: optionalNumberScalar(db, "SELECT MAX(depth) AS value FROM summary_nodes"),
    latest_event_at: optionalStringScalar(db, "SELECT MAX(timestamp) AS value FROM events"),
    latest_summary_node_at: optionalStringScalar(db, "SELECT MAX(latest_at) AS value FROM summary_nodes"),
  };
}

export function listStoredSessions(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  args: ListSessionsArgs,
  limit: number,
  offset: number,
  since: string | undefined,
  until: string | undefined,
): SessionPage {
  if (!db) {
    const rawEvents = readRawEvents(rawLogPath);
    const matches = summarizeSessions(rawEvents)
      .filter((session) => !since || session.last_seen >= since)
      .filter((session) => !until || session.first_seen <= until)
      .filter((session) => !args.cwd || session.cwd === args.cwd)
      .filter((session) => !args.repoRoot || session.repo_root === args.repoRoot)
      .filter((session) => !args.rootsOnly || !session.parent_session_id)
      .filter((session) => !args.parentSessionId || session.parent_session_id === args.parentSessionId);
    const eventsBySession = args.includeSummaries ? groupEventsBySession(rawEvents) : undefined;
    const sessions = matches.slice(offset, offset + limit).map((session) => {
      const events = eventsBySession?.get(session.session_id) ?? [];
      return events.length > 0
        ? { ...session, summary: sessionListSummary(buildSessionMemorySummary(events)) }
        : session;
    });
    return {
      sessions,
      ...(offset + sessions.length < matches.length ? { next_cursor: String(offset + sessions.length) } : {}),
    };
  }
  const summaryColumns = args.includeSummaries ? `,
      ss.updated_at AS summary_updated_at,
      ss.title AS summary_title,
      ss.overview AS summary_overview,
      ss.topics_json AS summary_topics_json,
      ss.key_prompts_json AS summary_key_prompts_json,
      ss.outcomes_json AS summary_outcomes_json,
      ss.source_event_ids_json AS summary_source_event_ids_json` : "";
  const summaryJoin = args.includeSummaries ? "LEFT JOIN session_summaries ss ON ss.session_id = s.session_id" : "";
  const rows = db.prepare(`
    SELECT s.*${summaryColumns}
    FROM sessions s
    ${summaryJoin}
    WHERE (?1 IS NULL OR s.last_seen >= ?1)
      AND (?2 IS NULL OR s.first_seen <= ?2)
      AND (?3 IS NULL OR s.cwd = ?3)
      AND (?4 IS NULL OR s.repo_root = ?4)
      AND (?5 = 0 OR s.parent_session_id IS NULL)
      AND (?6 IS NULL OR s.parent_session_id = ?6)
    ORDER BY s.last_seen DESC, s.session_id ASC
    LIMIT ?7 OFFSET ?8
  `).all(
    since ?? null,
    until ?? null,
    args.cwd ?? null,
    args.repoRoot ?? null,
    args.rootsOnly ? 1 : 0,
    args.parentSessionId ?? null,
    limit + 1,
    offset,
  );
  const sessions = rows.slice(0, limit).map(rowToSessionSummary);
  return {
    sessions,
    ...(rows.length > limit ? { next_cursor: String(offset + limit) } : {}),
  };
}

export function storedUsage(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  args: Omit<ListSessionsArgs, "limit" | "cursor">,
  since: string | undefined,
  until: string | undefined,
): UsageReport {
  if (!db) {
    const allSessions = summarizeSessions(readRawEvents(rawLogPath));
    let sessions = allSessions
      .filter((session) => !since || session.last_seen >= since)
      .filter((session) => !until || session.first_seen <= until)
      .filter((session) => !args.cwd || session.cwd === args.cwd)
      .filter((session) => !args.repoRoot || session.repo_root === args.repoRoot)
      .filter((session) => !args.parentSessionId || session.parent_session_id === args.parentSessionId);
    if (args.rootsOnly) sessions = sessionsWithDescendants(allSessions, sessions.filter((session) => !session.parent_session_id));
    return usageFromSessions(sessions);
  }
  if (args.rootsOnly) {
    const row = db.prepare(`
      WITH RECURSIVE selected_sessions(session_id) AS (
        SELECT session_id
        FROM sessions
        WHERE parent_session_id IS NULL
          AND (?1 IS NULL OR last_seen >= ?1)
          AND (?2 IS NULL OR first_seen <= ?2)
          AND (?3 IS NULL OR cwd = ?3)
          AND (?4 IS NULL OR repo_root = ?4)
          AND (?5 IS NULL OR parent_session_id = ?5)
        UNION
        SELECT child.session_id
        FROM sessions child
        JOIN selected_sessions parent ON child.parent_session_id = parent.session_id
      )
      SELECT
        COUNT(*) AS sessions,
        COALESCE(SUM(s.total_input_tokens), 0) AS input_tokens,
        COALESCE(SUM(s.cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
        COALESCE(SUM(s.reasoning_output_tokens), 0) AS reasoning_output_tokens,
        COALESCE(SUM(s.total_tokens), 0) AS total_tokens
      FROM sessions s
      JOIN selected_sessions selected ON selected.session_id = s.session_id
    `).get(
      since ?? null,
      until ?? null,
      args.cwd ?? null,
      args.repoRoot ?? null,
      args.parentSessionId ?? null,
    );
    return usageReportFromRow(recordValue(row));
  }
  const row = db.prepare(`
    SELECT
      COUNT(*) AS sessions,
      COALESCE(SUM(total_input_tokens), 0) AS input_tokens,
      COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(reasoning_output_tokens), 0) AS reasoning_output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM sessions
    WHERE (?1 IS NULL OR last_seen >= ?1)
      AND (?2 IS NULL OR first_seen <= ?2)
      AND (?3 IS NULL OR cwd = ?3)
      AND (?4 IS NULL OR repo_root = ?4)
      AND (?5 IS NULL OR parent_session_id = ?5)
  `).get(
    since ?? null,
    until ?? null,
    args.cwd ?? null,
    args.repoRoot ?? null,
    args.parentSessionId ?? null,
  );
  return usageReportFromRow(recordValue(row));
}

export function getCurrentStoredSession(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  args: { sessionId?: string; cwd?: string; repoRoot?: string },
): SessionSummary | undefined {
  if (args.sessionId) return getStoredSessionSummary(db, rawLogPath, args.sessionId);
  if (!db) {
    return summarizeSessions(readRawEvents(rawLogPath)
      .filter((event) => !args.cwd || event.cwd === args.cwd)
      .filter((event) => !args.repoRoot || event.repo_root === args.repoRoot))[0];
  }
  const row = db.prepare(`
    SELECT *
    FROM sessions
    WHERE (?1 IS NULL OR cwd = ?1)
      AND (?2 IS NULL OR repo_root = ?2)
    ORDER BY last_seen DESC
    LIMIT 1
  `).get(args.cwd ?? null, args.repoRoot ?? null);
  return row ? rowToSessionSummary(row) : undefined;
}

export function resolveStoredSessionIdentifier(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  identifier: string,
): string | undefined {
  const trimmed = identifier.trim();
  if (trimmed.length === 0) return undefined;
  const direct = getStoredSessionSummary(db, rawLogPath, trimmed);
  if (direct) return direct.session_id;
  if (!db) {
    const events = readRawEvents(rawLogPath);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.session_id === trimmed || stringField(event.payload.agent_id) === trimmed || stringField(event.payload.agentId) === trimmed) {
        return event.session_id;
      }
    }
    return undefined;
  }
  const row = recordValue(db.prepare(`
    SELECT session_id
    FROM events
    WHERE agent_id = ?1
    ORDER BY timestamp DESC, rowid DESC
    LIMIT 1
  `).get(trimmed));
  return typeof row.session_id === "string" ? row.session_id : undefined;
}

export function getStoredSession(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  sessionId: string,
  limit: number | undefined,
  offset: number,
): SessionDetail {
  const session = getStoredSessionSummary(db, rawLogPath, sessionId);
  if (!db) {
    const allEvents = readRawEvents(rawLogPath).filter((event) => event.session_id === sessionId);
    const events = limit === undefined ? allEvents.slice(offset) : allEvents.slice(offset, offset + limit);
    return {
      session,
      events,
      ...(limit !== undefined && offset + events.length < allEvents.length ? { next_cursor: String(offset + events.length) } : {}),
    };
  }
  const rows = limit === undefined
    ? db.prepare(`
        SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
        WHERE session_id = ?1
        ORDER BY timestamp ASC, rowid ASC
      `).all(sessionId)
    : db.prepare(`
        SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
        WHERE session_id = ?1
        ORDER BY timestamp ASC, rowid ASC
        LIMIT ?2 OFFSET ?3
      `).all(sessionId, limit, offset);
  const events = rows.map((row) => decodePersistedEvent(String(recordValue(row).raw_json)));
  const total = session?.event_count ?? events.length;
  return {
    session,
    events,
    ...(limit !== undefined && offset + events.length < total ? { next_cursor: String(offset + events.length) } : {}),
  };
}

export function getStoredSessionSummary(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  sessionId: string,
): SessionSummary | undefined {
  if (!db) {
    return summarizeSessions(readRawEvents(rawLogPath).filter((event) => event.session_id === sessionId))[0];
  }
  const row = db.prepare(`
    SELECT *
    FROM sessions
    WHERE session_id = ?1
  `).get(sessionId);
  return row ? rowToSessionSummary(row) : undefined;
}

function countEventsByHook(events: NormalizedEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.hook_event] = (counts[event.hook_event] ?? 0) + 1;
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function scalar(db: DatabaseSync | undefined, sql: string): number {
  if (!db) return 0;
  return Number(recordValue(db.prepare(sql).get()).count);
}

function optionalNumberScalar(db: DatabaseSync | undefined, sql: string): number | null {
  if (!db) return null;
  const value = recordValue(db.prepare(sql).get()).value;
  return typeof value === "number" ? value : null;
}

function optionalStringScalar(db: DatabaseSync | undefined, sql: string): string | null {
  if (!db) return null;
  const value = recordValue(db.prepare(sql).get()).value;
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function countMap(db: DatabaseSync | undefined, sql: string): Record<string, number> {
  if (!db) return {};
  return Object.fromEntries(db.prepare(sql).all().map((row) => {
    const record = recordValue(row);
    return [String(record.key), Number(record.count)];
  }));
}

function groupEventsBySession(events: NormalizedEvent[]): Map<string, NormalizedEvent[]> {
  const grouped = new Map<string, NormalizedEvent[]>();
  for (const event of events) {
    const sessionEvents = grouped.get(event.session_id) ?? [];
    sessionEvents.push(event);
    grouped.set(event.session_id, sessionEvents);
  }
  return grouped;
}

export function isCodexLcmToolEvent(event: NormalizedEvent): boolean {
  const toolName = event.tool_name || stringField(event.payload.tool_name) || stringField(event.payload.toolName);
  return toolName?.startsWith("mcp__codex_lcm__") ?? false;
}

export function isSearchIndexEvent(event: NormalizedEvent): boolean {
  return isSummarySourceEvent(event) || isGeneratedSuggestionEvent(event);
}

export function isSummaryHook(hookEvent: string): boolean {
  return hookEvent === "UserPromptSubmit" ||
    hookEvent === "Note" ||
    hookEvent === "Stop" ||
    hookEvent === "PreCompact" ||
    hookEvent === "PostCompact";
}
