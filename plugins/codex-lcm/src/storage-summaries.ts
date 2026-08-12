import type { DatabaseSync } from "node:sqlite";

import { decodePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";
import { readRawEvents } from "./raw-log.ts";
import { recordValue, rowToSessionMemorySummary, rowToSummaryNode } from "./storage-rows.ts";
import { STORED_EVENT_JSON_SQL } from "./stored-event.ts";
import type { SearchSessionArgs } from "./storage-types.ts";
import { isCodexLcmToolEvent, isSummaryHook } from "./storage-sessions.ts";
import {
  SUMMARY_ALGORITHM_VERSION,
  SUMMARY_NODE_CHUNK_SIZE,
  SUMMARY_NODE_FANOUT,
  SUMMARY_NODE_MAX_DEPTH,
  SUMMARY_NODE_SOURCE_EVENT_LIMIT,
  SUMMARY_NODE_VERSION,
  buildCondensedSummaryNode,
  buildLeafSummaryNode,
  buildSessionMemorySummary,
  eventSignalText,
  isSummarySourceEvent,
  matchesQueryText,
  queryTermHitCount,
  rankSummaryNodesForContext,
  summaryNodeSearchText,
  summarySearchText,
  takeHeadTail,
  toFtsQueries,
  type SessionMemorySummary,
  type SummaryNode,
} from "./summary.ts";

type SummaryNodeSearchArgs = SearchSessionArgs & {
  sessionIds?: string[];
};

const SUMMARY_EARLY_SIGNAL_LIMIT = 120;
const SUMMARY_LATEST_SIGNAL_LIMIT = 240;
const SUMMARY_RECENT_EVENT_LIMIT = 40;
const SUMMARY_SOURCE_HOOKS = "('UserPromptSubmit', 'Note', 'Stop', 'PreCompact', 'PostCompact')";

export function getSessionMemorySummary(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  sessionId: string,
): SessionMemorySummary | undefined {
  if (!db) {
    const events = readRawEvents(rawLogPath).filter((event) => event.session_id === sessionId);
    return events.length > 0 ? buildSessionMemorySummary(events) : undefined;
  }
  const row = db.prepare(`
    SELECT session_id, updated_at, cwd, repo_root, git_branch, title, overview, topics_json,
           key_prompts_json, outcomes_json, tools_json, source_event_ids_json
    FROM session_summaries
    WHERE session_id = ?1
  `).get(sessionId);
  return row ? rowToSessionMemorySummary(row) : undefined;
}

export function getSummaryNodesForSession(
  db: DatabaseSync | undefined,
  sessionId: string,
  limit = 200,
): SummaryNode[] {
  if (!db) return [];
  return db.prepare(`
    SELECT node_id, session_id, depth, summary_text, token_count, source_token_count, source_type,
           source_ids_json, source_event_ids_json, earliest_at, latest_at, created_at,
           cwd, repo_root, git_branch, topics_json
    FROM summary_nodes
    WHERE session_id = ?1
    ORDER BY depth ASC, earliest_at ASC, node_id ASC
    LIMIT ?2
  `).all(sessionId, clampSummaryLimit(limit, 200, 2_000)).map(rowToSummaryNode);
}

export function getTopSummaryNodesForSession(
  db: DatabaseSync | undefined,
  sessionId: string,
  limit = 3,
): SummaryNode[] {
  if (!db) return [];
  return db.prepare(`
    SELECT node_id, session_id, depth, summary_text, token_count, source_token_count, source_type,
           source_ids_json, source_event_ids_json, earliest_at, latest_at, created_at,
           cwd, repo_root, git_branch, topics_json
    FROM summary_nodes
    WHERE session_id = ?1
      AND depth = (SELECT MAX(depth) FROM summary_nodes WHERE session_id = ?1)
    ORDER BY latest_at DESC
    LIMIT ?2
  `).all(sessionId, clampSummaryLimit(limit, 3, 20)).map(rowToSummaryNode);
}

export function getSummaryNodesForGraph(
  db: DatabaseSync | undefined,
  sessionId: string,
  limit = 50,
): SummaryNode[] {
  const cappedLimit = clampSummaryLimit(limit, 50, 500);
  const nodes = getSummaryNodesForSession(db, sessionId, 2_000);
  const byId = new Map(nodes.map((node) => [node.node_id, node]));
  const selected = new Map<string, SummaryNode>();

  const addWithLineage = (node: SummaryNode): void => {
    if (selected.has(node.node_id) || selected.size >= cappedLimit) return;
    selected.set(node.node_id, node);
    if (node.source_type !== "nodes") return;
    for (const sourceId of node.source_ids) {
      const sourceNode = byId.get(sourceId);
      if (!sourceNode) continue;
      addWithLineage(sourceNode);
      if (selected.size >= cappedLimit) break;
    }
  };

  const roots = [...nodes].sort((a, b) =>
    b.depth - a.depth ||
    b.latest_at.localeCompare(a.latest_at) ||
    a.earliest_at.localeCompare(b.earliest_at) ||
    a.node_id.localeCompare(b.node_id));
  for (const node of roots) {
    addWithLineage(node);
    if (selected.size >= cappedLimit) break;
  }

  return [...selected.values()].sort((a, b) =>
    a.depth - b.depth ||
    a.earliest_at.localeCompare(b.earliest_at) ||
    a.node_id.localeCompare(b.node_id));
}

export function searchSummaryNodes(db: DatabaseSync | undefined, args: SummaryNodeSearchArgs): SummaryNode[] {
  const limit = clampSummaryLimit(args.limit, 10);
  if (!db) return [];
  const query = args.query?.trim() ?? "";
  const sessionFilter = args.sessionIds?.length ? new Set(args.sessionIds) : undefined;
  if (query.length === 0) {
    const rows = db.prepare(`
      SELECT node_id, session_id, depth, summary_text, token_count, source_token_count, source_type,
             source_ids_json, source_event_ids_json, earliest_at, latest_at, created_at,
             cwd, repo_root, git_branch, topics_json
      FROM summary_nodes
      WHERE (?1 IS NULL OR cwd = ?1)
        AND (?2 IS NULL OR repo_root = ?2)
      ORDER BY depth DESC, latest_at DESC
      LIMIT ?3
    `).all(args.cwd ?? null, args.repoRoot ?? null, Math.max(limit * 4, 20));
    return rows
      .map(rowToSummaryNode)
      .filter((node) => !sessionFilter || sessionFilter.has(node.session_id))
      .slice(0, limit);
  }

  let rows: unknown[] = [];
  const statement = db.prepare(`
    SELECT n.node_id, n.session_id, n.depth, n.summary_text, n.token_count, n.source_token_count,
           n.source_type, n.source_ids_json, n.source_event_ids_json, n.earliest_at, n.latest_at,
           n.created_at, n.cwd, n.repo_root, n.git_branch, n.topics_json
    FROM summary_node_fts f
    JOIN summary_nodes n ON n.rowid = f.rowid
    WHERE summary_node_fts MATCH ?1
      AND (?2 IS NULL OR n.cwd = ?2)
      AND (?3 IS NULL OR n.repo_root = ?3)
    ORDER BY bm25(summary_node_fts) ASC, n.depth DESC, n.latest_at DESC
    LIMIT ?4
  `);
  for (const ftsQuery of toFtsQueries(query)) {
    rows = statement.all(ftsQuery, args.cwd ?? null, args.repoRoot ?? null, Math.max(limit * 10, 50));
    if (rows.length > 0) break;
  }
  const nodes = rows
    .map(rowToSummaryNode)
    .filter((node) => !sessionFilter || sessionFilter.has(node.session_id));
  return rankSummaryNodesForContext(nodes, query).slice(0, limit);
}

export function getSummaryNode(db: DatabaseSync | undefined, nodeId: string): SummaryNode | undefined {
  if (!db) return undefined;
  const row = db.prepare(`
    SELECT node_id, session_id, depth, summary_text, token_count, source_token_count, source_type,
           source_ids_json, source_event_ids_json, earliest_at, latest_at, created_at,
           cwd, repo_root, git_branch, topics_json
    FROM summary_nodes
    WHERE node_id = ?1
  `).get(nodeId);
  return row ? rowToSummaryNode(row) : undefined;
}

export function getSourceSummaryNodes(
  db: DatabaseSync | undefined,
  node: SummaryNode,
  limit = 4,
): SummaryNode[] {
  if (node.source_type !== "nodes") return [];
  return node.source_ids
    .flatMap((nodeId) => getSummaryNode(db, nodeId) ?? [])
    .slice(0, clampSummaryLimit(limit, 4, 50));
}

export function getSummaryNodeSourceEvents(
  db: DatabaseSync | undefined,
  node: SummaryNode,
  query = "",
  limit = SUMMARY_NODE_SOURCE_EVENT_LIMIT,
): NormalizedEvent[] {
  if (!db) return [];
  const sourceEventIds = node.source_type === "events" ? node.source_ids : node.source_event_ids;
  const maxFetch = node.source_type === "events"
    ? sourceEventIds.length
    : Math.max(clampSummaryLimit(limit, SUMMARY_NODE_SOURCE_EVENT_LIMIT, 20) * 8, 32);
  const selectedIds = takeHeadTail(sourceEventIds, Math.min(sourceEventIds.length, maxFetch), Math.ceil(maxFetch / 2));
  if (selectedIds.length === 0) return [];
  const placeholders = selectedIds.map((_, index) => `?${index + 1}`).join(", ");
  const rows = db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
    WHERE event_id IN (${placeholders})
    ORDER BY timestamp ASC, rowid ASC
  `).all(...selectedIds);
  return rows
    .map(decodeEventRow)
    .filter(isSummarySourceEvent)
    .filter((event) => !isCodexLcmToolEvent(event))
    .sort((a, b) =>
      queryTermHitCount(eventSignalText(b), query) - queryTermHitCount(eventSignalText(a), query) ||
      a.timestamp.localeCompare(b.timestamp) ||
      a.event_id.localeCompare(b.event_id))
    .slice(0, clampSummaryLimit(limit, SUMMARY_NODE_SOURCE_EVENT_LIMIT, 20));
}

export function getSessionSummarySourceEvents(
  db: DatabaseSync | undefined,
  summary: SessionMemorySummary,
  query: string,
  limit: number,
): NormalizedEvent[] {
  if (!db || summary.source_event_ids.length === 0) return [];
  const placeholders = summary.source_event_ids.map((_, index) => `?${index + 1}`).join(", ");
  const events = db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json
    FROM events
    WHERE event_id IN (${placeholders})
    ORDER BY timestamp ASC, rowid ASC
  `).all(...summary.source_event_ids)
    .map(decodeEventRow)
    .filter(isSummarySourceEvent)
    .filter((event) => !isCodexLcmToolEvent(event));
  const matching = events.filter((event) => matchesQueryText(eventSignalText(event), query));
  return (matching.length > 0 ? matching : events)
    .sort((a, b) =>
      queryTermHitCount(eventSignalText(b), query) - queryTermHitCount(eventSignalText(a), query) ||
      a.timestamp.localeCompare(b.timestamp) ||
      a.event_id.localeCompare(b.event_id))
    .slice(0, clampSummaryLimit(limit, SUMMARY_NODE_SOURCE_EVENT_LIMIT, 20));
}

export function getSummaryBackfillSessionIds(db: DatabaseSync | undefined): string[] {
  if (!db) return [];
  return db.prepare(`
    SELECT s.session_id
    FROM sessions s
    LEFT JOIN session_summaries ss ON ss.session_id = s.session_id
    LEFT JOIN (
      SELECT session_id, MAX(summary_version) AS summary_node_version
      FROM summary_nodes
      GROUP BY session_id
    ) sn ON sn.session_id = s.session_id
    WHERE ss.session_id IS NULL
       OR ss.summary_version IS NULL
       OR ss.summary_version < ${SUMMARY_ALGORITHM_VERSION}
       OR sn.summary_node_version IS NULL
       OR sn.summary_node_version < ${SUMMARY_NODE_VERSION}
    ORDER BY s.last_seen DESC
    LIMIT 5
  `).all().map((row) => String(recordValue(row).session_id));
}

export function shouldRebuildSessionMemorySummary(
  db: DatabaseSync | undefined,
  event: NormalizedEvent,
): boolean {
  if (!db || !isSummarySourceEvent(event)) return false;
  if (event.hook_event !== "UserPromptSubmit") return true;
  const existingSummary = db.prepare("SELECT 1 FROM session_summaries WHERE session_id = ?1 LIMIT 1").get(event.session_id);
  if (!existingSummary) return true;
  const row = recordValue(db.prepare(`
    SELECT COUNT(*) AS count FROM events
    WHERE session_id = ?1
      AND hook_event IN ${SUMMARY_SOURCE_HOOKS}
  `).get(event.session_id));
  const highSignalCount = Number(row.count ?? 0);
  const chunkOffset = highSignalCount % SUMMARY_NODE_CHUNK_SIZE;
  return chunkOffset === 0 || chunkOffset === 1;
}

export function rebuildSessionMemorySummary(db: DatabaseSync | undefined, sessionId: string): void {
  if (!db) return;
  const events = getSummaryEventsForSession(db, sessionId);
  if (events.length === 0) {
    db.prepare("DELETE FROM session_summary_fts WHERE rowid IN (SELECT rowid FROM session_summaries WHERE session_id = ?1)").run(sessionId);
    db.prepare("DELETE FROM session_summaries WHERE session_id = ?1").run(sessionId);
    rebuildSummaryNodes(db, sessionId);
    return;
  }
  const summary = buildSessionMemorySummary(events);
  const summaryText = summarySearchText(summary);
  db.prepare("DELETE FROM session_summary_fts WHERE rowid IN (SELECT rowid FROM session_summaries WHERE session_id = ?1)").run(sessionId);
  db.prepare(`
    INSERT INTO session_summaries
      (session_id, summary_version, updated_at, cwd, repo_root, git_branch, title, overview, topics_json,
       key_prompts_json, outcomes_json, tools_json, source_event_ids_json, summary_text)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
    ON CONFLICT(session_id) DO UPDATE SET
      summary_version = excluded.summary_version,
      updated_at = excluded.updated_at,
      cwd = excluded.cwd,
      repo_root = excluded.repo_root,
      git_branch = excluded.git_branch,
      title = excluded.title,
      overview = excluded.overview,
      topics_json = excluded.topics_json,
      key_prompts_json = excluded.key_prompts_json,
      outcomes_json = excluded.outcomes_json,
      tools_json = excluded.tools_json,
      source_event_ids_json = excluded.source_event_ids_json,
      summary_text = excluded.summary_text
  `).run(
    summary.session_id,
    SUMMARY_ALGORITHM_VERSION,
    summary.updated_at,
    summary.cwd,
    summary.repo_root ?? null,
    summary.git_branch ?? null,
    summary.title,
    summary.overview,
    JSON.stringify(summary.topics),
    JSON.stringify(summary.key_prompts),
    JSON.stringify(summary.outcomes),
    JSON.stringify(summary.tools),
    JSON.stringify(summary.source_event_ids),
    summaryText,
  );
  db.prepare(`
    INSERT INTO session_summary_fts (rowid, session_id, cwd, repo_root, content)
    SELECT rowid, ?1, ?2, ?3, ?4 FROM session_summaries WHERE session_id = ?1
  `).run(summary.session_id, summary.cwd, summary.repo_root ?? "", summaryText);
  rebuildSummaryNodes(db, sessionId);
}

function rebuildSummaryNodes(db: DatabaseSync, sessionId: string): void {
  const sourceEvents = getAllSummarySourceEventsForSession(db, sessionId);
  let previousDepth = chunkSummaryValues(sourceEvents, SUMMARY_NODE_CHUNK_SIZE)
    .map((events) => buildLeafSummaryNode(events));
  const nodes: SummaryNode[] = [];
  nodes.push(...previousDepth);

  for (let depth = 1; depth <= SUMMARY_NODE_MAX_DEPTH && previousDepth.length > 1; depth += 1) {
    const condensed = chunkSummaryValues(previousDepth, SUMMARY_NODE_FANOUT)
      .map((nodesAtDepth) => buildCondensedSummaryNode(nodesAtDepth, depth));
    nodes.push(...condensed);
    previousDepth = condensed;
  }

  const existing = new Map<string, number>();
  const existingRows = db.prepare(`
    SELECT node_id, summary_version FROM summary_nodes WHERE session_id = ?1
  `).all(sessionId);
  for (const row of existingRows) {
    const record = recordValue(row);
    existing.set(String(record.node_id), Number(record.summary_version));
  }
  const nextIds = new Set(nodes.map((node) => node.node_id));
  const deleteFts = db.prepare("DELETE FROM summary_node_fts WHERE rowid IN (SELECT rowid FROM summary_nodes WHERE node_id = ?1)");
  const deleteNode = db.prepare("DELETE FROM summary_nodes WHERE node_id = ?1");
  for (const nodeId of existing.keys()) {
    if (nextIds.has(nodeId)) continue;
    deleteFts.run(nodeId);
    deleteNode.run(nodeId);
  }
  for (const node of nodes) {
    const existingVersion = existing.get(node.node_id);
    if (existingVersion === SUMMARY_NODE_VERSION) continue;
    if (existingVersion !== undefined) deleteFts.run(node.node_id);
    insertSummaryNode(db, node);
  }
}

function insertSummaryNode(db: DatabaseSync, node: SummaryNode): void {
  db.prepare(`
    INSERT INTO summary_nodes
      (node_id, session_id, summary_version, depth, summary_text, token_count, source_token_count,
       source_type, source_ids_json, source_event_ids_json, earliest_at, latest_at, created_at,
       cwd, repo_root, git_branch, topics_json)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)
    ON CONFLICT(node_id) DO UPDATE SET
      summary_version = excluded.summary_version,
      depth = excluded.depth,
      summary_text = excluded.summary_text,
      token_count = excluded.token_count,
      source_token_count = excluded.source_token_count,
      source_type = excluded.source_type,
      source_ids_json = excluded.source_ids_json,
      source_event_ids_json = excluded.source_event_ids_json,
      earliest_at = excluded.earliest_at,
      latest_at = excluded.latest_at,
      created_at = excluded.created_at,
      cwd = excluded.cwd,
      repo_root = excluded.repo_root,
      git_branch = excluded.git_branch,
      topics_json = excluded.topics_json
  `).run(
    node.node_id,
    node.session_id,
    SUMMARY_NODE_VERSION,
    node.depth,
    node.summary_text,
    node.token_count,
    node.source_token_count,
    node.source_type,
    JSON.stringify(node.source_ids),
    JSON.stringify(node.source_event_ids),
    node.earliest_at,
    node.latest_at,
    node.created_at,
    node.cwd,
    node.repo_root ?? null,
    node.git_branch ?? null,
    JSON.stringify(node.topics),
  );
  db.prepare(`
    INSERT INTO summary_node_fts (rowid, node_id, session_id, cwd, repo_root, depth, content)
    SELECT rowid, ?1, ?2, ?3, ?4, ?5, ?6 FROM summary_nodes WHERE node_id = ?1
  `).run(
    node.node_id,
    node.session_id,
    node.cwd,
    node.repo_root ?? "",
    String(node.depth),
    summaryNodeSearchText(node),
  );
}

function getAllSummarySourceEventsForSession(db: DatabaseSync, sessionId: string): NormalizedEvent[] {
  return db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
    WHERE session_id = ?1
      AND hook_event IN ('UserPromptSubmit', 'Note', 'Stop', 'PreCompact', 'PostCompact')
    ORDER BY timestamp ASC, rowid ASC
  `).all(sessionId)
    .map(decodeEventRow)
    .filter((event) => !isCodexLcmToolEvent(event))
    .filter(isSummarySourceEvent);
}

function getSummaryEventsForSession(db: DatabaseSync, sessionId: string): NormalizedEvent[] {
  const earlySignals = db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
    WHERE session_id = ?1
      AND hook_event IN ${SUMMARY_SOURCE_HOOKS}
    ORDER BY timestamp ASC, rowid ASC
    LIMIT ?2
  `).all(sessionId, SUMMARY_EARLY_SIGNAL_LIMIT);
  const latestSignals = db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
    WHERE session_id = ?1
      AND hook_event IN ${SUMMARY_SOURCE_HOOKS}
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ?2
  `).all(sessionId, SUMMARY_LATEST_SIGNAL_LIMIT);
  const recentEvents = db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
    WHERE session_id = ?1
    ORDER BY timestamp DESC, rowid DESC
    LIMIT ?2
  `).all(sessionId, SUMMARY_RECENT_EVENT_LIMIT);
  const events = uniqueSummaryEvents([...earlySignals, ...latestSignals, ...recentEvents]
    .map(decodeEventRow)
    .filter((event) => !isCodexLcmToolEvent(event))
    .filter((event) => !isSummaryHook(event.hook_event) || isSummarySourceEvent(event)))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));
  return events.some(isSummarySourceEvent) ? events : [];
}

function decodeEventRow(row: unknown): NormalizedEvent {
  return decodePersistedEvent(String(recordValue(row).raw_json));
}

function uniqueSummaryEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  const seen = new Set<string>();
  return events.filter((event) => {
    if (seen.has(event.event_id)) return false;
    seen.add(event.event_id);
    return true;
  });
}

function clampSummaryLimit(limit: number | undefined, fallback: number, max = 200): number {
  return Math.min(Math.max(Number(limit ?? fallback), 1), max);
}

function chunkSummaryValues<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
