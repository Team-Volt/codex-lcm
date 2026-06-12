import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig, type LcmConfig } from "./config.ts";
import { createNoteEvent, type NormalizedEvent } from "./events.ts";
import {
  SUMMARY_ALGORITHM_VERSION,
  SUMMARY_NODE_CHUNK_SIZE,
  SUMMARY_NODE_FANOUT,
  SUMMARY_NODE_MAX_DEPTH,
  SUMMARY_NODE_PACK_LIMIT,
  SUMMARY_NODE_SOURCE_EVENT_LIMIT,
  SUMMARY_NODE_VERSION,
  buildCondensedSummaryNode,
  buildLeafSummaryNode,
  buildSessionMemorySummary,
  estimateTokenCount,
  eventSignalText,
  isSummarySourceEvent,
  matchesQueryText,
  queryTermHitCount,
  rankSummaryNodesForContext,
  sessionSummaryToMarkdown,
  summaryNodeExpansionToMarkdown,
  summaryNodeSearchText,
  summaryNodeTitle,
  summaryNodeToCompactMarkdown,
  summaryNodeToMarkdown,
  summarySearchText,
  takeHeadTail,
  toFtsQueries,
  type SessionMemorySummary,
  type SummaryNode,
  type SummarySourceType,
} from "./summary.ts";

export type { SessionMemorySummary, SummaryNode, SummarySourceType } from "./summary.ts";

export type StorageOptions = {
  home?: string;
  config?: LcmConfig;
};

export type SearchSessionArgs = {
  query?: string;
  limit?: number;
  cwd?: string;
  repoRoot?: string;
};

export type SearchEventArgs = SearchSessionArgs & {
  sessionIds?: string[];
};

export type SessionSummary = {
  session_id: string;
  first_seen: string;
  last_seen: string;
  cwd: string;
  repo_root?: string;
  git_branch?: string;
  event_count: number;
  match_count?: number;
};

export type SessionDetail = {
  session: SessionSummary | undefined;
  events: NormalizedEvent[];
  next_cursor?: string;
};

export type RecentContext = {
  session_id?: string;
  events: NormalizedEvent[];
};

export type PackedContext = {
  markdown: string;
  estimated_tokens: number;
  sources: Array<{ kind: "event" | "note" | "checkpoint" | "summary"; session_id: string; event_id?: string; node_id?: string; timestamp: string }>;
};

export type GraphNode = {
  node_id: string;
  kind: "session" | "turn" | "event" | "checkpoint" | "summary";
  session_id: string;
  event_id?: string;
  turn_id?: string;
  timestamp: string;
  cwd: string;
  repo_root?: string;
  git_branch?: string;
  label: string;
  metadata: Record<string, unknown>;
};

export type GraphEdge = {
  from_node_id: string;
  to_node_id: string;
  kind: "contains" | "next" | "tool_result" | "checkpoint" | string;
  session_id: string;
  position: number;
  created_at: string;
  metadata: Record<string, unknown>;
};

export type SessionGraph = {
  session_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type Health = {
  home: string;
  raw_log_path: string;
  index_path: string;
  raw_log_exists: boolean;
  index_exists: boolean;
  index_available: boolean;
  index_error?: string;
  event_count: number;
  session_count: number;
  graph_node_count?: number;
  graph_edge_count?: number;
  summary_count?: number;
  summary_node_count?: number;
};

const CHECKPOINT_INTERVAL = 50;
const SUMMARY_EARLY_SIGNAL_LIMIT = 120;
const SUMMARY_LATEST_SIGNAL_LIMIT = 240;
const SUMMARY_RECENT_EVENT_LIMIT = 40;

export class LcmStorage {
  readonly config: LcmConfig;
  private db?: DatabaseSync;
  private indexError?: string;

  constructor(options: StorageOptions = {}) {
    this.config = options.config ?? loadConfig({ home: options.home });
    fs.mkdirSync(this.config.home, { recursive: true, mode: 0o700 });
    try {
      this.db = new DatabaseSync(this.config.indexPath);
      this.initialize();
      this.backfillGraph();
      this.backfillSessionMemorySummaries();
    } catch (error) {
      this.db = undefined;
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  close(): void {
    this.db?.close();
  }

  ingest(event: NormalizedEvent): void {
    fs.mkdirSync(path.dirname(this.config.rawLogPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.config.rawLogPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (!this.db) return;
    try {
      this.indexEvent(event);
    } catch (error) {
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  health(): Health {
    const rawEvents = this.db ? undefined : readRawEvents(this.config.rawLogPath);
    return {
      home: this.config.home,
      raw_log_path: this.config.rawLogPath,
      index_path: this.config.indexPath,
      raw_log_exists: fs.existsSync(this.config.rawLogPath),
      index_exists: fs.existsSync(this.config.indexPath),
      index_available: this.db !== undefined,
      ...(this.indexError ? { index_error: this.indexError } : {}),
      event_count: this.db ? Number(this.scalar("SELECT COUNT(*) AS count FROM events")) : rawEvents?.length ?? 0,
      session_count: this.db ? Number(this.scalar("SELECT COUNT(*) AS count FROM sessions")) : summarizeSessions(rawEvents ?? []).length,
      ...(this.db ? {
        graph_node_count: Number(this.scalar("SELECT COUNT(*) AS count FROM graph_nodes")),
        graph_edge_count: Number(this.scalar("SELECT COUNT(*) AS count FROM graph_edges")),
        summary_count: Number(this.scalar("SELECT COUNT(*) AS count FROM session_summaries")),
        summary_node_count: Number(this.scalar("SELECT COUNT(*) AS count FROM summary_nodes")),
      } : {}),
    };
  }

  searchSessions(args: SearchSessionArgs): SessionSummary[] {
    const limit = clampLimit(args.limit, 10);
    if (!this.db) {
      const query = args.query?.trim() ?? "";
      return summarizeSessions(readRawEvents(this.config.rawLogPath)
        .filter((event) => !args.cwd || event.cwd === args.cwd)
        .filter((event) => !args.repoRoot || event.repo_root === args.repoRoot)
        .filter((event) => matchesQueryText(JSON.stringify(event), query)))
        .slice(0, limit);
    }
    const query = args.query?.trim() ?? "";
    if (query.length === 0) {
      return this.db.prepare(`
        SELECT session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count
        FROM sessions
        WHERE (?1 IS NULL OR cwd = ?1)
          AND (?2 IS NULL OR repo_root = ?2)
        ORDER BY last_seen DESC
        LIMIT ?3
      `).all(args.cwd ?? null, args.repoRoot ?? null, limit).map(rowToSessionSummary);
    }

    let rows: unknown[] = [];
    const eventStatement = this.db.prepare(`
        SELECT s.session_id, s.first_seen, s.last_seen, s.cwd, s.repo_root, s.git_branch, s.event_count,
               e.raw_json AS match_text, e.timestamp AS match_timestamp, 1 AS match_weight
        FROM event_fts f
        JOIN events e ON e.event_id = f.event_id
        JOIN sessions s ON s.session_id = e.session_id
        WHERE event_fts MATCH ?1
          AND (?2 IS NULL OR s.cwd = ?2)
          AND (?3 IS NULL OR s.repo_root = ?3)
        ORDER BY bm25(event_fts) ASC, e.timestamp DESC
        LIMIT ?4
      `);
    const summaryStatement = this.db.prepare(`
        SELECT s.session_id, s.first_seen, s.last_seen, s.cwd, s.repo_root, s.git_branch, s.event_count,
               ss.summary_text AS match_text, ss.updated_at AS match_timestamp, 3 AS match_weight
        FROM session_summary_fts f
        JOIN session_summaries ss ON ss.session_id = f.session_id
        JOIN sessions s ON s.session_id = ss.session_id
        WHERE session_summary_fts MATCH ?1
          AND (?2 IS NULL OR s.cwd = ?2)
          AND (?3 IS NULL OR s.repo_root = ?3)
        ORDER BY bm25(session_summary_fts) ASC, ss.updated_at DESC
        LIMIT ?4
      `);
    const summaryNodeStatement = this.db.prepare(`
        SELECT s.session_id, s.first_seen, s.last_seen, s.cwd, s.repo_root, s.git_branch, s.event_count,
               n.summary_text AS match_text, n.latest_at AS match_timestamp, 4 AS match_weight
        FROM summary_node_fts f
        JOIN summary_nodes n ON n.node_id = f.node_id
        JOIN sessions s ON s.session_id = n.session_id
        WHERE summary_node_fts MATCH ?1
          AND (?2 IS NULL OR s.cwd = ?2)
          AND (?3 IS NULL OR s.repo_root = ?3)
        ORDER BY bm25(summary_node_fts) ASC, n.depth DESC, n.latest_at DESC
        LIMIT ?4
      `);
    for (const ftsQuery of toFtsQueries(query)) {
      rows = summaryNodeStatement.all(ftsQuery, args.cwd ?? null, args.repoRoot ?? null, Math.max(limit * 20, 50));
      if (rows.length > 0) break;
      rows = summaryStatement.all(ftsQuery, args.cwd ?? null, args.repoRoot ?? null, Math.max(limit * 20, 50));
      if (rows.length > 0) break;
      rows = eventStatement.all(ftsQuery, args.cwd ?? null, args.repoRoot ?? null, Math.max(limit * 20, 50));
      if (rows.length > 0) break;
    }
    return rankSessionRows(rows, query).slice(0, limit);
  }

  getCurrentSession(args: { sessionId?: string; cwd?: string; repoRoot?: string } = {}): SessionSummary | undefined {
    if (args.sessionId) return this.getSessionSummary(args.sessionId);
    if (!this.db) {
      return summarizeSessions(readRawEvents(this.config.rawLogPath)
        .filter((event) => !args.cwd || event.cwd === args.cwd)
        .filter((event) => !args.repoRoot || event.repo_root === args.repoRoot))[0];
    }
    const row = this.db.prepare(`
      SELECT session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count
      FROM sessions
      WHERE (?1 IS NULL OR cwd = ?1)
        AND (?2 IS NULL OR repo_root = ?2)
      ORDER BY last_seen DESC
      LIMIT 1
    `).get(args.cwd ?? null, args.repoRoot ?? null);
    return row ? rowToSessionSummary(row) : undefined;
  }

  getSession(sessionId: string, args: { limit?: number; cursor?: string } = {}): SessionDetail {
    const session = this.getSessionSummary(sessionId);
    const offset = parseCursor(args.cursor);
    const limit = args.limit === undefined ? undefined : clampLimit(args.limit, 200);
    if (!this.db) {
      const allEvents = readRawEvents(this.config.rawLogPath).filter((event) => event.session_id === sessionId);
      const events = limit === undefined ? allEvents.slice(offset) : allEvents.slice(offset, offset + limit);
      return {
        session,
        events,
        ...(limit !== undefined && offset + events.length < allEvents.length ? { next_cursor: String(offset + events.length) } : {}),
      };
    }
    const rows = limit === undefined
      ? this.db.prepare(`
          SELECT raw_json FROM events
          WHERE session_id = ?1
          ORDER BY timestamp ASC, rowid ASC
        `).all(sessionId)
      : this.db.prepare(`
          SELECT raw_json FROM events
          WHERE session_id = ?1
          ORDER BY timestamp ASC, rowid ASC
          LIMIT ?2 OFFSET ?3
        `).all(sessionId, limit, offset);
    const events = rows.map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent);
    const total = session?.event_count ?? events.length;
    return {
      session,
      events,
      ...(limit !== undefined && offset + events.length < total ? { next_cursor: String(offset + events.length) } : {}),
    };
  }

  getSessionGraph(sessionId: string, args: { limit?: number } = {}): SessionGraph {
    const limit = clampLimit(args.limit, 200, 1_000);
    if (!this.db) return buildFallbackGraph(readRawEvents(this.config.rawLogPath).filter((event) => event.session_id === sessionId), limit);

    const summaryBudget = limit >= 20
      ? Math.min(Math.max(Math.ceil(limit * 0.25), 8), Math.floor(limit / 2))
      : Math.max(0, Math.floor(limit / 4));
    const graphNodeLimit = Math.max(1, limit - summaryBudget);
    const nodes = this.db.prepare(`
      SELECT node_id, kind, session_id, event_id, turn_id, timestamp, cwd, repo_root, git_branch, label, metadata_json
      FROM graph_nodes
      WHERE session_id = ?1
      ORDER BY timestamp ASC,
        CASE kind WHEN 'session' THEN 0 WHEN 'turn' THEN 1 WHEN 'checkpoint' THEN 2 ELSE 3 END,
        node_id ASC
      LIMIT ?2
    `).all(sessionId, graphNodeLimit).map(rowToGraphNode);
    const remainingNodeBudget = Math.max(0, limit - nodes.length);
    const rawSummaryNodes = remainingNodeBudget > 0
      ? this.getSummaryNodesForGraph(sessionId, remainingNodeBudget)
      : [];
    const summaryNodes = rawSummaryNodes.map(summaryNodeToGraphNode);
    nodes.push(...summaryNodes);
    if (nodes.length === 0) return { session_id: sessionId, nodes: [], edges: [] };

    const nodeIds = new Set(nodes.map((node) => node.node_id));
    const nodeIdList = [...nodeIds];
    const placeholders = nodeIdList.map((_, index) => `?${index + 2}`).join(", ");
    const edges = this.db.prepare(`
      SELECT from_node_id, to_node_id, kind, session_id, position, created_at, metadata_json
      FROM graph_edges
      WHERE session_id = ?1
        AND from_node_id IN (${placeholders})
        AND to_node_id IN (${placeholders})
      ORDER BY position ASC, created_at ASC, kind ASC
    `).all(sessionId, ...nodeIdList)
      .map(rowToGraphEdge)
      .filter((edge) => nodeIds.has(edge.from_node_id) && nodeIds.has(edge.to_node_id));
    edges.push(...rawSummaryNodes.flatMap((node) => summaryGraphEdges(node, nodeIds)));
    return { session_id: sessionId, nodes, edges };
  }

  searchEvents(args: SearchEventArgs): NormalizedEvent[] {
    const limit = clampLimit(args.limit, 20);
    const query = args.query?.trim() ?? "";
    if (!this.db) {
      return readRawEvents(this.config.rawLogPath)
        .filter((event) => !args.cwd || event.cwd === args.cwd)
        .filter((event) => !args.repoRoot || event.repo_root === args.repoRoot)
        .filter((event) => !args.sessionIds?.length || args.sessionIds.includes(event.session_id))
        .filter((event) => matchesQueryText(JSON.stringify(event), query))
        .slice(0, limit);
    }
    if (query.length === 0) {
      return this.db.prepare(`
        SELECT raw_json FROM events
        WHERE (?1 IS NULL OR cwd = ?1)
          AND (?2 IS NULL OR repo_root = ?2)
        ORDER BY timestamp DESC, rowid DESC
        LIMIT ?3
      `).all(args.cwd ?? null, args.repoRoot ?? null, limit)
        .map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent);
    }

    const sessionFilter = args.sessionIds?.length ? new Set(args.sessionIds) : undefined;
    let rows: unknown[] = [];
    const statement = this.db.prepare(`
        SELECT e.raw_json, e.session_id
        FROM event_fts f
        JOIN events e ON e.event_id = f.event_id
        WHERE event_fts MATCH ?1
          AND (?2 IS NULL OR e.cwd = ?2)
          AND (?3 IS NULL OR e.repo_root = ?3)
        ORDER BY bm25(event_fts) ASC, e.timestamp DESC
        LIMIT ?4
      `);
    for (const ftsQuery of toFtsQueries(query)) {
      rows = statement.all(ftsQuery, args.cwd ?? null, args.repoRoot ?? null, Math.max(limit * 10, 50));
      if (rows.length > 0) break;
    }
    const events = rows
      .filter((row) => !sessionFilter || sessionFilter.has(String((row as { session_id: string }).session_id)))
      .map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent);
    return rankEventsForContext(events, query).slice(0, limit);
  }

  private getLatestCheckpoint(sessionId: string): GraphNode | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare(`
      SELECT node_id, kind, session_id, event_id, turn_id, timestamp, cwd, repo_root, git_branch, label, metadata_json
      FROM graph_nodes
      WHERE session_id = ?1 AND kind = 'checkpoint'
      ORDER BY timestamp DESC, node_id DESC
      LIMIT 1
    `).get(sessionId);
    return row ? rowToGraphNode(row) : undefined;
  }

  getRecentContext(args: { sessionId?: string; cwd?: string; repoRoot?: string; limit?: number } = {}): RecentContext {
    const session = this.getCurrentSession({
      sessionId: args.sessionId,
      cwd: args.cwd,
      repoRoot: args.repoRoot,
    });
    if (!session) return { events: [] };
    const limit = clampLimit(args.limit, 20);
    if (!this.db) {
      const events = readRawEvents(this.config.rawLogPath)
        .filter((event) => event.session_id === session.session_id)
        .slice(-limit);
      return { session_id: session.session_id, events };
    }
    const rows = this.db.prepare(`
      SELECT raw_json FROM (
        SELECT raw_json, timestamp, rowid
        FROM events
        WHERE session_id = ?1
        ORDER BY timestamp DESC, rowid DESC
        LIMIT ?2
      )
      ORDER BY timestamp ASC, rowid ASC
    `).all(session.session_id, limit);
    return {
      session_id: session.session_id,
      events: rows.map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent),
    };
  }

  recordNote(args: { sessionId: string; cwd: string; text: string }): NormalizedEvent {
    const event = createNoteEvent({
      sessionId: args.sessionId,
      cwd: args.cwd,
      text: args.text,
    });
    this.ingest(event);
    return event;
  }

  getSessionMemorySummary(sessionId: string): SessionMemorySummary | undefined {
    if (!this.db) {
      const events = readRawEvents(this.config.rawLogPath).filter((event) => event.session_id === sessionId);
      return events.length > 0 ? buildSessionMemorySummary(events) : undefined;
    }
    const row = this.db.prepare(`
      SELECT session_id, updated_at, cwd, repo_root, git_branch, title, overview, topics_json,
             key_prompts_json, outcomes_json, tools_json, source_event_ids_json
      FROM session_summaries
      WHERE session_id = ?1
    `).get(sessionId);
    return row ? rowToSessionMemorySummary(row) : undefined;
  }

  getSummaryNodesForSession(sessionId: string, limit = 200): SummaryNode[] {
    if (!this.db) return [];
    return this.db.prepare(`
      SELECT node_id, session_id, depth, summary_text, token_count, source_token_count, source_type,
             source_ids_json, source_event_ids_json, earliest_at, latest_at, created_at,
             cwd, repo_root, git_branch, topics_json
      FROM summary_nodes
      WHERE session_id = ?1
      ORDER BY depth ASC, earliest_at ASC, node_id ASC
      LIMIT ?2
    `).all(sessionId, clampLimit(limit, 200, 2_000)).map(rowToSummaryNode);
  }

  private getTopSummaryNodesForSession(sessionId: string, limit = 3): SummaryNode[] {
    const nodes = this.getSummaryNodesForSession(sessionId, 2_000);
    if (nodes.length === 0) return [];
    const maxDepth = Math.max(...nodes.map((node) => node.depth));
    return nodes
      .filter((node) => node.depth === maxDepth)
      .sort((a, b) => b.latest_at.localeCompare(a.latest_at))
      .slice(0, clampLimit(limit, 3, 20));
  }

  private getSummaryNodesForGraph(sessionId: string, limit = 50): SummaryNode[] {
    const cappedLimit = clampLimit(limit, 50, 500);
    const nodes = this.getSummaryNodesForSession(sessionId, 2_000);
    const byId = new Map(nodes.map((node) => [node.node_id, node]));
    const selected = new Map<string, SummaryNode>();

    const addWithLineage = (node: SummaryNode) => {
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

  private searchSummaryNodes(args: SearchEventArgs): SummaryNode[] {
    const limit = clampLimit(args.limit, 10);
    if (!this.db) return [];
    const query = args.query?.trim() ?? "";
    const sessionFilter = args.sessionIds?.length ? new Set(args.sessionIds) : undefined;
    if (query.length === 0) {
      const rows = this.db.prepare(`
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
    const statement = this.db.prepare(`
      SELECT n.node_id, n.session_id, n.depth, n.summary_text, n.token_count, n.source_token_count,
             n.source_type, n.source_ids_json, n.source_event_ids_json, n.earliest_at, n.latest_at,
             n.created_at, n.cwd, n.repo_root, n.git_branch, n.topics_json
      FROM summary_node_fts f
      JOIN summary_nodes n ON n.node_id = f.node_id
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

  private getSummaryNode(nodeId: string): SummaryNode | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare(`
      SELECT node_id, session_id, depth, summary_text, token_count, source_token_count, source_type,
             source_ids_json, source_event_ids_json, earliest_at, latest_at, created_at,
             cwd, repo_root, git_branch, topics_json
      FROM summary_nodes
      WHERE node_id = ?1
    `).get(nodeId);
    return row ? rowToSummaryNode(row) : undefined;
  }

  private getSummaryNodeSourceEvents(
    node: SummaryNode,
    query = "",
    limit = SUMMARY_NODE_SOURCE_EVENT_LIMIT,
  ): NormalizedEvent[] {
    if (!this.db) return [];
    const sourceEventIds = node.source_type === "events"
      ? node.source_ids
      : node.source_event_ids;
    const maxFetch = node.source_type === "events"
      ? sourceEventIds.length
      : Math.max(clampLimit(limit, SUMMARY_NODE_SOURCE_EVENT_LIMIT, 20) * 8, 32);
    const selectedIds = takeHeadTail(sourceEventIds, Math.min(sourceEventIds.length, maxFetch), Math.ceil(maxFetch / 2));
    if (selectedIds.length === 0) return [];
    const placeholders = selectedIds.map((_, index) => `?${index + 1}`).join(", ");
    const rows = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE event_id IN (${placeholders})
      ORDER BY timestamp ASC, rowid ASC
    `).all(...selectedIds);
    return rows
      .map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent)
      .filter(isSummarySourceEvent)
      .filter((event) => !isCodexLcmToolEvent(event))
      .sort((a, b) =>
        queryTermHitCount(eventSignalText(b), query) - queryTermHitCount(eventSignalText(a), query) ||
        a.timestamp.localeCompare(b.timestamp) ||
        a.event_id.localeCompare(b.event_id))
      .slice(0, clampLimit(limit, SUMMARY_NODE_SOURCE_EVENT_LIMIT, 20));
  }

  packContext(args: { query?: string; sessionIds?: string[]; budgetTokens?: number; cwd?: string } = {}): PackedContext {
    const budgetTokens = Math.max(16, args.budgetTokens ?? 1200);
    const budgetChars = budgetTokens * 4;
    const summaryCandidates = new Map<string, SessionMemorySummary>();
    const checkpointCandidates = new Map<string, GraphNode>();
    const summaryNodeCandidates = new Map<string, SummaryNode>();
    const query = args.query?.trim() ?? "";
    const candidateSessionIds = new Set(args.sessionIds ?? []);

    const addSummaryNode = (node: SummaryNode) => {
      summaryNodeCandidates.set(node.node_id, node);
      candidateSessionIds.add(node.session_id);
    };

    if (query.length > 0) {
      let nodes = this.searchSummaryNodes({
        query,
        cwd: args.cwd,
        sessionIds: args.sessionIds,
        limit: SUMMARY_NODE_PACK_LIMIT,
      });
      if (nodes.length === 0 && args.cwd && !args.sessionIds?.length) {
        nodes = this.searchSummaryNodes({ query, limit: SUMMARY_NODE_PACK_LIMIT });
      }
      for (const node of nodes) addSummaryNode(node);

      if (summaryNodeCandidates.size === 0 && !args.sessionIds?.length) {
        let sessions = this.searchSessions({ query, cwd: args.cwd, limit: 8 });
        if (sessions.length === 0 && args.cwd) {
          sessions = this.searchSessions({ query, limit: 8 });
        }
        for (const session of sessions) {
          candidateSessionIds.add(session.session_id);
          for (const node of this.getTopSummaryNodesForSession(session.session_id, 2)) addSummaryNode(node);
        }
      }
    } else {
      if (candidateSessionIds.size === 0) {
        const session = this.getCurrentSession({ cwd: args.cwd });
        if (session) candidateSessionIds.add(session.session_id);
      }
      for (const sessionId of candidateSessionIds) {
        for (const node of this.getTopSummaryNodesForSession(sessionId, 3)) addSummaryNode(node);
      }
    }

    if (candidateSessionIds.size === 0) {
      let sessions = this.searchSessions({ query: args.query, cwd: args.cwd, limit: 8 });
      if (sessions.length === 0 && query.length > 0 && args.cwd && !args.sessionIds?.length) {
        sessions = this.searchSessions({ query: args.query, limit: 8 });
      }
      for (const session of sessions) candidateSessionIds.add(session.session_id);
    }

    for (const sessionId of candidateSessionIds) {
      const summary = this.getSessionMemorySummary(sessionId);
      if (summary) summaryCandidates.set(sessionId, summary);
      const checkpoint = this.getLatestCheckpoint(sessionId);
      if (checkpoint) checkpointCandidates.set(checkpoint.node_id, checkpoint);
    }

    const lines = ["# Codex LCM Context", ""];
    const sources: PackedContext["sources"] = [];
    let chars = lines.join("\n").length;

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
          ? node.source_ids.flatMap((nodeId) => this.getSummaryNode(nodeId) ?? []).slice(0, 4)
          : [];
        const sourceEvents = this.getSummaryNodeSourceEvents(node, query);
        const text = [
          summaryNodeToMarkdown(node),
          summaryNodeExpansionToMarkdown(node, {
            sourceNodes,
            sourceEvents,
          }),
        ].filter(Boolean).join("\n");
        const compactText = summaryNodeToCompactMarkdown(node, { sourceEvents });
        return { node, sourceEvents, text, compactText };
      });

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

    if (query.length > 0) {
      addSummaryNodeItems();
      addSummaryItems();
      addCheckpointItems();
    } else {
      addSummaryNodeItems();
      addSummaryItems();
      addCheckpointItems();
    }

    return {
      markdown: lines.join("\n"),
      estimated_tokens: Math.ceil(chars / 4),
      sources,
    };
  }

  private initialize(): void {
    if (!this.db) return;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT,
        git_branch TEXT,
        event_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        hook_event TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT,
        git_branch TEXT,
        turn_id TEXT,
        tool_use_id TEXT,
        text TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
        event_id UNINDEXED,
        session_id,
        cwd,
        repo_root,
        hook_event,
        content
      );
      CREATE TABLE IF NOT EXISTS graph_nodes (
        node_id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        event_id TEXT,
        turn_id TEXT,
        timestamp TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT,
        git_branch TEXT,
        label TEXT NOT NULL,
        metadata_json TEXT NOT NULL,
        UNIQUE(event_id)
      );
      CREATE TABLE IF NOT EXISTS graph_edges (
        from_node_id TEXT NOT NULL,
        to_node_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        session_id TEXT NOT NULL,
        position INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        PRIMARY KEY (from_node_id, to_node_id, kind),
        CHECK (from_node_id <> to_node_id)
      );
      CREATE TABLE IF NOT EXISTS session_summaries (
        session_id TEXT PRIMARY KEY,
        summary_version INTEGER NOT NULL DEFAULT ${SUMMARY_ALGORITHM_VERSION},
        updated_at TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT,
        git_branch TEXT,
        title TEXT NOT NULL,
        overview TEXT NOT NULL,
        topics_json TEXT NOT NULL,
        key_prompts_json TEXT NOT NULL,
        outcomes_json TEXT NOT NULL,
        tools_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        summary_text TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS session_summary_fts USING fts5(
        session_id UNINDEXED,
        cwd,
        repo_root,
        content
      );
      CREATE TABLE IF NOT EXISTS summary_nodes (
        node_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        summary_version INTEGER NOT NULL DEFAULT ${SUMMARY_NODE_VERSION},
        depth INTEGER NOT NULL,
        summary_text TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        source_token_count INTEGER NOT NULL,
        source_type TEXT NOT NULL,
        source_ids_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL,
        earliest_at TEXT NOT NULL,
        latest_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT,
        git_branch TEXT,
        topics_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS summary_node_fts USING fts5(
        node_id UNINDEXED,
        session_id,
        cwd,
        repo_root,
        depth,
        content
      );
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_session_kind_time ON graph_nodes(session_id, kind, timestamp);
      CREATE INDEX IF NOT EXISTS idx_graph_nodes_event ON graph_nodes(event_id);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges(from_node_id, kind);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges(to_node_id, kind);
      CREATE INDEX IF NOT EXISTS idx_graph_edges_session ON graph_edges(session_id, kind, position);
      CREATE INDEX IF NOT EXISTS idx_session_summaries_updated ON session_summaries(updated_at);
      CREATE INDEX IF NOT EXISTS idx_summary_nodes_session_depth_latest ON summary_nodes(session_id, depth, latest_at);
      CREATE INDEX IF NOT EXISTS idx_summary_nodes_session_latest ON summary_nodes(session_id, latest_at);
    `);
    this.ensureColumn("events", "turn_id", "TEXT");
    this.ensureColumn("events", "tool_use_id", "TEXT");
    this.ensureColumn("session_summaries", "summary_version", "INTEGER");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_session_turn ON events(session_id, turn_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_tool_use ON events(session_id, tool_use_id, hook_event, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_session_hook_time ON events(session_id, hook_event, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, timestamp);
    `);
  }

  private indexEvent(event: NormalizedEvent): void {
    if (!this.db) return;
    const raw = JSON.stringify(event);
    const text = eventSearchText(event);
    const metadata = extractEventMetadata(event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO events
          (event_id, session_id, timestamp, hook_event, cwd, repo_root, git_branch, turn_id, tool_use_id, text, raw_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      `).run(
        event.event_id,
        event.session_id,
        event.timestamp,
        event.hook_event,
        event.cwd,
        event.repo_root ?? null,
        event.git_branch ?? null,
        metadata.turn_id ?? null,
        metadata.tool_use_id ?? null,
        text,
        raw,
      );
      if ((insert as { changes?: number }).changes === 0) {
        this.db.exec("COMMIT");
        return;
      }
      this.db.prepare(`
        INSERT INTO sessions (session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count)
        VALUES (?1, ?2, ?2, ?3, ?4, ?5, 1)
        ON CONFLICT(session_id) DO UPDATE SET
          last_seen = CASE WHEN excluded.last_seen > sessions.last_seen THEN excluded.last_seen ELSE sessions.last_seen END,
          cwd = excluded.cwd,
          repo_root = COALESCE(excluded.repo_root, sessions.repo_root),
          git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
          event_count = sessions.event_count + 1
      `).run(
        event.session_id,
        event.timestamp,
        event.cwd,
        event.repo_root ?? null,
        event.git_branch ?? null,
      );
      this.db.prepare(`
        INSERT INTO event_fts (event_id, session_id, cwd, repo_root, hook_event, content)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `).run(
        event.event_id,
        event.session_id,
        event.cwd,
        event.repo_root ?? "",
        event.hook_event,
        text,
      );
      const eventCount = Number(this.db.prepare("SELECT event_count FROM sessions WHERE session_id = ?1").get(event.session_id)?.event_count ?? 1);
      const currentRow = this.db.prepare("SELECT rowid FROM events WHERE event_id = ?1").get(event.event_id) as { rowid?: number } | undefined;
      this.indexGraphForEvent(event, eventCount, Number(currentRow?.rowid ?? 0));
      this.rebuildSessionMemorySummary(event.session_id);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures; the original indexing error is more useful.
      }
      throw error;
    }
  }

  private indexGraphForEvent(event: NormalizedEvent, eventCount: number, currentRowId = 0): void {
    if (!this.db) return;
    const metadata = extractEventMetadata(event);
    const sessionNode = sessionNodeId(event.session_id);
    this.insertGraphNode({
      node_id: sessionNode,
      kind: "session",
      session_id: event.session_id,
      timestamp: event.timestamp,
      cwd: event.cwd,
      repo_root: event.repo_root,
      git_branch: event.git_branch,
      label: `Session ${event.session_id}`,
      metadata: { event_count: eventCount },
    });

    const eventNode = eventNodeId(event.event_id);
    this.insertGraphNode({
      node_id: eventNode,
      kind: "event",
      session_id: event.session_id,
      event_id: event.event_id,
      turn_id: metadata.turn_id,
      timestamp: event.timestamp,
      cwd: event.cwd,
      repo_root: event.repo_root,
      git_branch: event.git_branch,
      label: `${event.hook_event} ${event.timestamp}`,
      metadata: {
        hook_event: event.hook_event,
        tool_name: event.tool_name,
        turn_id: metadata.turn_id,
        tool_use_id: metadata.tool_use_id,
      },
    });

    if (metadata.turn_id) {
      const turnNode = turnNodeId(event.session_id, metadata.turn_id);
      this.insertGraphNode({
        node_id: turnNode,
        kind: "turn",
        session_id: event.session_id,
        turn_id: metadata.turn_id,
        timestamp: event.timestamp,
        cwd: event.cwd,
        repo_root: event.repo_root,
        git_branch: event.git_branch,
        label: `Turn ${metadata.turn_id}`,
        metadata: { turn_id: metadata.turn_id },
      });
      this.insertGraphEdge(sessionNode, turnNode, "contains", event.session_id, eventCount, event.timestamp);
      this.insertGraphEdge(turnNode, eventNode, "contains", event.session_id, eventCount, event.timestamp);
    } else {
      this.insertGraphEdge(sessionNode, eventNode, "contains", event.session_id, eventCount, event.timestamp);
    }

    const previous = this.db.prepare(`
      SELECT event_id FROM events
      WHERE session_id = ?1
        AND event_id <> ?2
        AND (?3 <= 0 OR rowid < ?3)
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `).get(event.session_id, event.event_id, currentRowId) as { event_id?: string } | undefined;
    if (previous?.event_id) {
      this.insertGraphEdge(eventNodeId(previous.event_id), eventNode, "next", event.session_id, eventCount, event.timestamp);
    }

    if (event.hook_event === "PostToolUse" && metadata.tool_use_id) {
      const preTool = this.db.prepare(`
        SELECT event_id FROM events
        WHERE session_id = ?1
          AND event_id <> ?2
          AND hook_event = 'PreToolUse'
          AND tool_use_id = ?3
          AND (?4 <= 0 OR rowid < ?4)
        ORDER BY timestamp DESC, rowid DESC
        LIMIT 1
      `).get(event.session_id, event.event_id, metadata.tool_use_id, currentRowId) as { event_id?: string } | undefined;
      if (preTool?.event_id) {
        this.insertGraphEdge(eventNodeId(preTool.event_id), eventNode, "tool_result", event.session_id, eventCount, event.timestamp, {
          tool_use_id: metadata.tool_use_id,
          tool_name: event.tool_name,
        });
      }
    }

    if (event.hook_event === "PreCompact" || eventCount % CHECKPOINT_INTERVAL === 0) {
      this.insertCheckpoint(event, eventCount);
    }
  }

  private insertCheckpoint(event: NormalizedEvent, eventCount: number): void {
    if (!this.db) return;
    const nodeId = checkpointNodeId(event.session_id, eventCount);
    const metadata = this.buildCheckpointMetadata(event.session_id, eventCount);
    this.insertGraphNode({
      node_id: nodeId,
      kind: "checkpoint",
      session_id: event.session_id,
      timestamp: event.timestamp,
      cwd: event.cwd,
      repo_root: event.repo_root,
      git_branch: event.git_branch,
      label: `Checkpoint after ${eventCount} events`,
      metadata,
    });
    this.insertGraphEdge(sessionNodeId(event.session_id), nodeId, "checkpoint", event.session_id, eventCount, event.timestamp, {
      event_count: eventCount,
      trigger_event_id: event.event_id,
      trigger_hook_event: event.hook_event,
    });
  }

  private buildCheckpointMetadata(sessionId: string, eventCount: number): Record<string, unknown> {
    if (!this.db) return { event_count: eventCount };
    const counts = this.db.prepare(`
      SELECT hook_event, COUNT(*) AS count
      FROM events
      WHERE session_id = ?1
      GROUP BY hook_event
      ORDER BY hook_event ASC
    `).all(sessionId).map((row) => ({
      hook_event: String((row as { hook_event: string }).hook_event),
      count: Number((row as { count: number }).count),
    }));
    const recent = this.db.prepare(`
      SELECT event_id, timestamp, hook_event
      FROM events
      WHERE session_id = ?1
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 5
    `).all(sessionId).map((row) => ({
      event_id: String((row as { event_id: string }).event_id),
      timestamp: String((row as { timestamp: string }).timestamp),
      hook_event: String((row as { hook_event: string }).hook_event),
    }));
    return {
      event_count: eventCount,
      hook_event_counts: counts,
      recent_events: recent,
    };
  }

  private insertGraphNode(node: GraphNode): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO graph_nodes
        (node_id, kind, session_id, event_id, turn_id, timestamp, cwd, repo_root, git_branch, label, metadata_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
      ON CONFLICT(node_id) DO UPDATE SET
        timestamp = CASE WHEN excluded.timestamp < graph_nodes.timestamp THEN excluded.timestamp ELSE graph_nodes.timestamp END,
        cwd = excluded.cwd,
        repo_root = COALESCE(excluded.repo_root, graph_nodes.repo_root),
        git_branch = COALESCE(excluded.git_branch, graph_nodes.git_branch),
        label = excluded.label,
        metadata_json = excluded.metadata_json
    `).run(
      node.node_id,
      node.kind,
      node.session_id,
      node.event_id ?? null,
      node.turn_id ?? null,
      node.timestamp,
      node.cwd,
      node.repo_root ?? null,
      node.git_branch ?? null,
      node.label,
      JSON.stringify(node.metadata),
    );
  }

  private insertGraphEdge(
    fromNodeId: string,
    toNodeId: string,
    kind: string,
    sessionId: string,
    position: number,
    createdAt: string,
    metadata: Record<string, unknown> = {},
  ): void {
    if (!this.db) return;
    if (this.wouldCreateCycle(fromNodeId, toNodeId)) {
      throw new Error(`Refusing to insert graph edge that would create a cycle: ${fromNodeId} -> ${toNodeId}`);
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO graph_edges
        (from_node_id, to_node_id, kind, session_id, position, created_at, metadata_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run(fromNodeId, toNodeId, kind, sessionId, position, createdAt, JSON.stringify(metadata));
  }

  private wouldCreateCycle(fromNodeId: string, toNodeId: string): boolean {
    if (!this.db) return false;
    if (fromNodeId === toNodeId) return true;
    const row = this.db.prepare(`
      WITH RECURSIVE reachable(node_id) AS (
        SELECT to_node_id FROM graph_edges WHERE from_node_id = ?1
        UNION
        SELECT graph_edges.to_node_id
        FROM graph_edges
        JOIN reachable ON graph_edges.from_node_id = reachable.node_id
      )
      SELECT 1 AS found FROM reachable WHERE node_id = ?2 LIMIT 1
    `).get(toNodeId, fromNodeId);
    return row !== undefined;
  }

  private ensureColumn(table: string, column: string, type: string): void {
    if (!this.db) return;
    const tableName = sqlIdentifier(table);
    const columnName = sqlIdentifier(column);
    const columnType = sqlColumnType(type);
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all()
      .map((row) => String((row as { name: string }).name));
    if (!columns.includes(columnName)) {
      this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
    }
  }

  private backfillGraph(): void {
    if (!this.db) return;
    const rows = this.db.prepare(`
      SELECT e.rowid AS rowid, e.raw_json
      FROM events e
      LEFT JOIN graph_nodes n ON n.event_id = e.event_id
      WHERE n.node_id IS NULL
      ORDER BY e.timestamp ASC, e.rowid ASC
      LIMIT 10000
    `).all();
    if (rows.length === 0) return;

    const counts = new Map<string, number>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const event = JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent;
        const metadata = extractEventMetadata(event);
        const count = (counts.get(event.session_id) ?? Number(this.db.prepare(`
          SELECT COUNT(*) AS count FROM graph_nodes WHERE session_id = ?1 AND kind = 'event'
        `).get(event.session_id)?.count ?? 0)) + 1;
        counts.set(event.session_id, count);
        this.db.prepare(`
          UPDATE events SET turn_id = ?1, tool_use_id = ?2 WHERE event_id = ?3
        `).run(metadata.turn_id ?? null, metadata.tool_use_id ?? null, event.event_id);
        this.indexGraphForEvent(event, count, Number((row as { rowid: number }).rowid));
      }
      for (const sessionId of counts.keys()) this.rebuildSessionMemorySummary(sessionId);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures; the original backfill error is more useful.
      }
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  private backfillSessionMemorySummaries(): void {
    if (!this.db) return;
    const rows = this.db.prepare(`
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
      LIMIT 1000
    `).all();
    if (rows.length === 0) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        this.rebuildSessionMemorySummary(String((row as { session_id: string }).session_id));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures; the original backfill error is more useful.
      }
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  private getSessionSummary(sessionId: string): SessionSummary | undefined {
    if (!this.db) {
      return summarizeSessions(readRawEvents(this.config.rawLogPath).filter((event) => event.session_id === sessionId))[0];
    }
    const row = this.db.prepare(`
      SELECT session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count
      FROM sessions
      WHERE session_id = ?1
    `).get(sessionId);
    return row ? rowToSessionSummary(row) : undefined;
  }

  private scalar(sql: string): number {
    if (!this.db) return 0;
    const row = this.db.prepare(sql).get() as { count: number };
    return row.count;
  }

  private rebuildSessionMemorySummary(sessionId: string): void {
    if (!this.db) return;
    const events = this.getSummaryEventsForSession(sessionId);
    if (events.length === 0) return;
    const summary = buildSessionMemorySummary(events);
    const summaryText = summarySearchText(summary);
    this.db.prepare("DELETE FROM session_summary_fts WHERE session_id = ?1").run(sessionId);
    this.db.prepare(`
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
    this.db.prepare(`
      INSERT INTO session_summary_fts (session_id, cwd, repo_root, content)
      VALUES (?1, ?2, ?3, ?4)
    `).run(summary.session_id, summary.cwd, summary.repo_root ?? "", summaryText);
    this.rebuildSummaryNodes(sessionId);
  }

  private rebuildSummaryNodes(sessionId: string): void {
    if (!this.db) return;
    const sourceEvents = this.getAllSummarySourceEventsForSession(sessionId);
    this.db.prepare("DELETE FROM summary_node_fts WHERE session_id = ?1").run(sessionId);
    this.db.prepare("DELETE FROM summary_nodes WHERE session_id = ?1").run(sessionId);
    if (sourceEvents.length === 0) return;

    let previousDepth = chunkArray(sourceEvents, SUMMARY_NODE_CHUNK_SIZE)
      .map((events) => buildLeafSummaryNode(events));
    for (const node of previousDepth) this.insertSummaryNode(node);

    for (let depth = 1; depth <= SUMMARY_NODE_MAX_DEPTH && previousDepth.length > 1; depth += 1) {
      const condensed = chunkArray(previousDepth, SUMMARY_NODE_FANOUT)
        .map((nodes) => buildCondensedSummaryNode(nodes, depth));
      for (const node of condensed) this.insertSummaryNode(node);
      previousDepth = condensed;
    }
  }

  private insertSummaryNode(node: SummaryNode): void {
    if (!this.db) return;
    this.db.prepare(`
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
    this.db.prepare(`
      INSERT INTO summary_node_fts (node_id, session_id, cwd, repo_root, depth, content)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(
      node.node_id,
      node.session_id,
      node.cwd,
      node.repo_root ?? "",
      String(node.depth),
      summaryNodeSearchText(node),
    );
  }

  private getAllSummarySourceEventsForSession(sessionId: string): NormalizedEvent[] {
    if (!this.db) return [];
    const rows = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE session_id = ?1
        AND hook_event IN ('UserPromptSubmit', 'Note', 'Stop', 'PreCompact')
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId);
    return rows
      .map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent)
      .filter((event) => !isCodexLcmToolEvent(event));
  }

  private getSummaryEventsForSession(sessionId: string): NormalizedEvent[] {
    if (!this.db) return [];
    const highSignalFilter = "('UserPromptSubmit', 'Note', 'Stop', 'PreCompact')";
    const earlySignals = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE session_id = ?1
        AND hook_event IN ${highSignalFilter}
      ORDER BY timestamp ASC, rowid ASC
      LIMIT ?2
    `).all(sessionId, SUMMARY_EARLY_SIGNAL_LIMIT);
    const latestSignals = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE session_id = ?1
        AND hook_event IN ${highSignalFilter}
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?2
    `).all(sessionId, SUMMARY_LATEST_SIGNAL_LIMIT);
    const recentEvents = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE session_id = ?1
      ORDER BY timestamp DESC, rowid DESC
      LIMIT ?2
    `).all(sessionId, SUMMARY_RECENT_EVENT_LIMIT);
    return uniqueEvents([...earlySignals, ...latestSignals, ...recentEvents]
      .map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent)
      .filter((event) => !isCodexLcmToolEvent(event)))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));
  }
}

export function createStorage(options: StorageOptions = {}): LcmStorage {
  return new LcmStorage(options);
}

function rowToSessionSummary(row: unknown): SessionSummary {
  const record = row as Record<string, unknown>;
  return {
    session_id: String(record.session_id),
    first_seen: String(record.first_seen),
    last_seen: String(record.last_seen),
    cwd: String(record.cwd),
    ...(record.repo_root ? { repo_root: String(record.repo_root) } : {}),
    ...(record.git_branch ? { git_branch: String(record.git_branch) } : {}),
    event_count: Number(record.event_count),
    ...(record.match_count !== undefined ? { match_count: Number(record.match_count) } : {}),
  };
}

function rowToSessionMemorySummary(row: unknown): SessionMemorySummary {
  const record = row as Record<string, unknown>;
  return {
    session_id: String(record.session_id),
    updated_at: String(record.updated_at),
    cwd: String(record.cwd),
    ...(record.repo_root ? { repo_root: String(record.repo_root) } : {}),
    ...(record.git_branch ? { git_branch: String(record.git_branch) } : {}),
    title: String(record.title),
    overview: String(record.overview),
    topics: parseStringArray(record.topics_json),
    key_prompts: parseStringArray(record.key_prompts_json),
    outcomes: parseStringArray(record.outcomes_json),
    tools: parseStringArray(record.tools_json),
    source_event_ids: parseStringArray(record.source_event_ids_json),
  };
}

function rowToSummaryNode(row: unknown): SummaryNode {
  const record = row as Record<string, unknown>;
  const sourceType = String(record.source_type) === "nodes" ? "nodes" : "events";
  return {
    node_id: String(record.node_id),
    session_id: String(record.session_id),
    depth: Number(record.depth),
    summary_text: String(record.summary_text),
    token_count: Number(record.token_count),
    source_token_count: Number(record.source_token_count),
    source_type: sourceType,
    source_ids: parseStringArray(record.source_ids_json),
    source_event_ids: parseStringArray(record.source_event_ids_json),
    earliest_at: String(record.earliest_at),
    latest_at: String(record.latest_at),
    created_at: String(record.created_at),
    cwd: String(record.cwd),
    ...(record.repo_root ? { repo_root: String(record.repo_root) } : {}),
    ...(record.git_branch ? { git_branch: String(record.git_branch) } : {}),
    topics: parseStringArray(record.topics_json),
  };
}

function summaryNodeToGraphNode(node: SummaryNode): GraphNode {
  return {
    node_id: node.node_id,
    kind: "summary",
    session_id: node.session_id,
    timestamp: node.latest_at,
    cwd: node.cwd,
    repo_root: node.repo_root,
    git_branch: node.git_branch,
    label: `D${node.depth} ${summaryNodeTitle(node)}`,
    metadata: {
      depth: node.depth,
      source_type: node.source_type,
      source_ids: node.source_ids,
      source_event_ids: node.source_event_ids,
      token_count: node.token_count,
      source_token_count: node.source_token_count,
      topics: node.topics,
      earliest_at: node.earliest_at,
      latest_at: node.latest_at,
    },
  };
}

function summaryGraphEdges(node: SummaryNode, nodeIds: Set<string>): GraphEdge[] {
  return node.source_ids.flatMap((sourceId, index) => {
    const targetId = node.source_type === "events" ? eventNodeId(sourceId) : sourceId;
    if (!nodeIds.has(node.node_id) || !nodeIds.has(targetId)) return [];
    return [{
      from_node_id: node.node_id,
      to_node_id: targetId,
      kind: "summary_source",
      session_id: node.session_id,
      position: index,
      created_at: node.created_at,
      metadata: {
        depth: node.depth,
        source_type: node.source_type,
      },
    }];
  });
}

function rankSessionRows(rows: unknown[], query: string): SessionSummary[] {
  const sessions = new Map<string, {
    summary: SessionSummary;
    score: number;
    matchCount: number;
    lastMatchAt: string;
    firstOrder: number;
  }>();
  rows.forEach((row, order) => {
    const record = row as Record<string, unknown>;
    const sessionId = String(record.session_id);
    const matchAt = String(record.match_timestamp ?? record.last_seen ?? "");
    const matchText = typeof record.match_text === "string" ? record.match_text : "";
    const weight = typeof record.match_weight === "number" ? record.match_weight : 1;
    const existing = sessions.get(sessionId);
    if (!existing) {
      sessions.set(sessionId, {
        summary: rowToSessionSummary(row),
        score: queryTermHitCount(matchText, query) * weight,
        matchCount: 1,
        lastMatchAt: matchAt,
        firstOrder: order,
      });
      return;
    }
    existing.score += queryTermHitCount(matchText, query) * weight;
    existing.matchCount += 1;
    if (matchAt > existing.lastMatchAt) existing.lastMatchAt = matchAt;
  });
  return [...sessions.values()]
    .sort((a, b) =>
      b.score - a.score ||
      b.matchCount - a.matchCount ||
      b.lastMatchAt.localeCompare(a.lastMatchAt) ||
      a.firstOrder - b.firstOrder)
    .map((entry) => entry.summary);
}

function rankEventsForContext(events: NormalizedEvent[], query: string): NormalizedEvent[] {
  return [...events].sort((a, b) =>
    eventContextPriority(a) - eventContextPriority(b) ||
    queryTermHitCount(JSON.stringify(b.payload), query) - queryTermHitCount(JSON.stringify(a.payload), query) ||
    b.timestamp.localeCompare(a.timestamp));
}

function eventContextPriority(event: NormalizedEvent): number {
  if (event.hook_event === "Note") return 0;
  if (event.hook_event === "UserPromptSubmit") return 1;
  if (event.hook_event === "PreCompact" || event.hook_event === "Stop") return 2;
  if (event.hook_event === "SessionStart") return 3;
  if (event.tool_name) return 5;
  return 4;
}

function rowToGraphNode(row: unknown): GraphNode {
  const record = row as Record<string, unknown>;
  return {
    node_id: String(record.node_id),
    kind: String(record.kind) as GraphNode["kind"],
    session_id: String(record.session_id),
    ...(record.event_id ? { event_id: String(record.event_id) } : {}),
    ...(record.turn_id ? { turn_id: String(record.turn_id) } : {}),
    timestamp: String(record.timestamp),
    cwd: String(record.cwd),
    ...(record.repo_root ? { repo_root: String(record.repo_root) } : {}),
    ...(record.git_branch ? { git_branch: String(record.git_branch) } : {}),
    label: String(record.label),
    metadata: parseMetadata(record.metadata_json),
  };
}

function rowToGraphEdge(row: unknown): GraphEdge {
  const record = row as Record<string, unknown>;
  return {
    from_node_id: String(record.from_node_id),
    to_node_id: String(record.to_node_id),
    kind: String(record.kind),
    session_id: String(record.session_id),
    position: Number(record.position),
    created_at: String(record.created_at),
    metadata: parseMetadata(record.metadata_json),
  };
}

function parseMetadata(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function clampLimit(limit: number | undefined, fallback: number, max = 200): number {
  return Math.min(Math.max(Number(limit ?? fallback), 1), max);
}

function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return value;
}

function sqlColumnType(value: string): string {
  if (!/^[A-Z][A-Z0-9_]*(?:\s+[A-Z][A-Z0-9_]*)*$/u.test(value)) {
    throw new Error(`Invalid SQL column type: ${value}`);
  }
  return value;
}

function eventSearchText(event: NormalizedEvent): string {
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

function checkpointToMarkdown(node: GraphNode): string {
  return [
    `## ${node.timestamp} Checkpoint`,
    `session: ${node.session_id}`,
    `cwd: ${node.cwd}`,
    JSON.stringify(node.metadata),
    "",
  ].join("\n");
}

function readRawEvents(rawLogPath: string): NormalizedEvent[] {
  if (!fs.existsSync(rawLogPath)) return [];
  return fs.readFileSync(rawLogPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as NormalizedEvent];
      } catch {
        return [];
      }
    });
}

function uniqueEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  const seen = new Set<string>();
  const result: NormalizedEvent[] = [];
  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    result.push(event);
  }
  return result;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function summarizeSessions(events: NormalizedEvent[]): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();
  for (const event of events) {
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
  }
  return [...sessions.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

function extractEventMetadata(event: NormalizedEvent): { turn_id?: string; tool_use_id?: string } {
  return {
    turn_id: stringField(event.payload.turn_id) || stringField(event.payload.turnId),
    tool_use_id: stringField(event.payload.tool_use_id) || stringField(event.payload.toolUseId),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isCodexLcmToolEvent(event: NormalizedEvent): boolean {
  const toolName = event.tool_name || stringField(event.payload.tool_name) || stringField(event.payload.toolName);
  return toolName?.startsWith("mcp__codex_lcm__") ?? false;
}

function sessionNodeId(sessionId: string): string {
  return `session:${sessionId}`;
}

function turnNodeId(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

function eventNodeId(eventId: string): string {
  return `event:${eventId}`;
}

function checkpointNodeId(sessionId: string, eventCount: number): string {
  return `checkpoint:${sessionId}:${eventCount}`;
}

function buildFallbackGraph(events: NormalizedEvent[], limit: number): SessionGraph {
  const sessionId = events[0]?.session_id ?? "";
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const addNode = (node: GraphNode) => {
    if (seen.has(node.node_id) || nodes.length >= limit) return;
    seen.add(node.node_id);
    nodes.push(node);
  };

  for (const [index, event] of events.entries()) {
    const metadata = extractEventMetadata(event);
    const sessionNode = sessionNodeId(event.session_id);
    addNode({
      node_id: sessionNode,
      kind: "session",
      session_id: event.session_id,
      timestamp: event.timestamp,
      cwd: event.cwd,
      repo_root: event.repo_root,
      git_branch: event.git_branch,
      label: `Session ${event.session_id}`,
      metadata: { fallback: true },
    });
    const parentNode = metadata.turn_id ? turnNodeId(event.session_id, metadata.turn_id) : sessionNode;
    if (metadata.turn_id) {
      addNode({
        node_id: parentNode,
        kind: "turn",
        session_id: event.session_id,
        turn_id: metadata.turn_id,
        timestamp: event.timestamp,
        cwd: event.cwd,
        repo_root: event.repo_root,
        git_branch: event.git_branch,
        label: `Turn ${metadata.turn_id}`,
        metadata: { fallback: true, turn_id: metadata.turn_id },
      });
      edges.push(fallbackEdge(sessionNode, parentNode, "contains", event.session_id, index, event.timestamp));
    }
    const eventNode = eventNodeId(event.event_id);
    addNode({
      node_id: eventNode,
      kind: "event",
      session_id: event.session_id,
      event_id: event.event_id,
      turn_id: metadata.turn_id,
      timestamp: event.timestamp,
      cwd: event.cwd,
      repo_root: event.repo_root,
      git_branch: event.git_branch,
      label: `${event.hook_event} ${event.timestamp}`,
      metadata: { fallback: true, hook_event: event.hook_event },
    });
    edges.push(fallbackEdge(parentNode, eventNode, "contains", event.session_id, index, event.timestamp));
    if (index > 0) {
      edges.push(fallbackEdge(eventNodeId(events[index - 1].event_id), eventNode, "next", event.session_id, index, event.timestamp));
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.node_id));
  return {
    session_id: sessionId,
    nodes,
    edges: edges.filter((edge) => nodeIds.has(edge.from_node_id) && nodeIds.has(edge.to_node_id)),
  };
}

function fallbackEdge(
  fromNodeId: string,
  toNodeId: string,
  kind: string,
  sessionId: string,
  position: number,
  createdAt: string,
): GraphEdge {
  return {
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    kind,
    session_id: sessionId,
    position,
    created_at: createdAt,
    metadata: { fallback: true },
  };
}
