// allow: SIZE_OK - legacy multi-responsibility file predates this feature; durable-memory API is 193 pure LOC and memory modules are <=188; broader splitting is an unrelated high-risk refactor.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig, type LcmConfig } from "./config.ts";
import {
  createMemoryEvent,
  createNoteEvent,
  type NormalizedEvent,
} from "./events.ts";
import { extractFileReferences, type FileReference } from "./file-refs.ts";
import { resolveGitMetadata } from "./git.ts";
import {
  resolveMemoryScope,
  rowToDurableMemory,
  type CreateMemoryArgs,
  type DurableMemory,
  type MemoryDetail,
  type MemoryReadArgs,
  type MemoryRevision,
  type MemorySearchArgs,
  type MemorySourceContext,
  type MemorySourceReference,
  type MemoryTransitionArgs,
  type ReviseMemoryArgs,
} from "./memory-domain.ts";
import { indexedMemorySourceContext, memoryApplies, memoryHistoryEnd, memoryHistoryLimit, memoryHistoryOffset, memoryScopeRank, memorySearchScore, memorySourceContext } from "./memory-query.ts";
import {
  acceptMemoryEvent,
  foldMemoryEvents,
  memoryRevisionFromAcceptedMemoryEvent,
  memoryRevisions,
  replayMemoryEvents,
  type MemoryAcceptance,
} from "./memory-replay.ts";
import {
  SUMMARY_ALGORITHM_VERSION,
  SUMMARY_NODE_CHUNK_SIZE,
  SUMMARY_NODE_FANOUT,
  SUMMARY_NODE_MAX_DEPTH,
  SUMMARY_NODE_PACK_LIMIT,
  SUMMARY_NODE_SOURCE_EVENT_LIMIT,
  SUMMARY_NODE_VERSION,
  HISTORICAL_SOURCE_TEXT_NOTICE,
  buildCondensedSummaryNode,
  buildLeafSummaryNode,
  buildSessionMemorySummary,
  estimateTokenCount,
  eventSignalText,
  isGeneratedSuggestionEvent,
  isSummarySourceEvent,
  matchesQueryText,
  queryTermHitCount,
  quoteHistoricalText,
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
} from "./summary.ts";

export type { FileReference } from "./file-refs.ts";
export type { SessionMemorySummary, SummaryNode, SummarySourceType } from "./summary.ts";

export type StorageOptions = {
  home?: string;
  config?: LcmConfig;
  readOnly?: boolean;
};

export type IngestManyResult = {
  imported: number;
  skippedDuplicate: number;
  touchedSessions: string[];
};

export type IngestManyOptions = {
  readonly rebuildSummaries?: boolean;
};

export type SearchSessionArgs = {
  query?: string;
  limit?: number;
  cwd?: string;
  repoRoot?: string;
  excludeCurrentSession?: boolean;
  excludeSessionIds?: string[];
};

export type { CreateMemoryArgs, DurableMemory, MemoryDetail, MemoryRevision, MemorySearchArgs, MemorySourceContext, MemorySourceReference, MemoryTransitionArgs, ReviseMemoryArgs } from "./memory-domain.ts";

type SummaryNodeSearchArgs = SearchSessionArgs & {
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
  best_match?: SessionSearchMatch;
  discovery?: SessionDiscovery;
};

export type SessionSearchMatch = {
  kind: "summary_node" | "session_summary" | "event";
  snippet: string;
  timestamp: string;
  score: number;
  node_id?: string;
  event_id?: string;
  depth?: number;
  topics?: string[];
  source_event_count?: number;
  source_token_count?: number;
};

export type SessionDiscovery = {
  confidence: "high" | "medium" | "low";
  score: number;
  reasons: string[];
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

export type ContextPlanState = "empty" | "under_limit" | "near_limit" | "over_limit" | "over_context";

export type ContextPlan = {
  session_id?: string;
  cwd?: string;
  repo_root?: string;
  model_context_window: number;
  auto_compact_token_limit: number;
  recent_event_limit: number;
  estimated_recent_tokens: number;
  estimated_summary_tokens: number;
  estimated_total_tokens: number;
  summary_node_count: number;
  latest_event_at: string | null;
  state: ContextPlanState;
  recommendation: string;
  suggested_tools: string[];
  can_control_compaction: false;
};

export type PackedContext = {
  markdown: string;
  estimated_tokens: number;
  sources: Array<{ kind: "event" | "note" | "checkpoint" | "summary" | "memory"; session_id: string; event_id?: string; node_id?: string; memory_id?: string; timestamp: string }>;
};

export type PackContextArgs = {
  query?: string;
  sessionIds?: string[];
  currentThreadId?: string;
  budgetTokens?: number;
  cwd?: string;
  repoRoot?: string;
};

export type QueryExpansionSource = {
  kind: "summary" | "event";
  session_id: string;
  timestamp: string;
  node_id?: string;
  event_id?: string;
  depth?: number;
  hook_event?: string;
};

export type LcmQueryExpansion = {
  query: string;
  markdown: string;
  estimated_tokens: number;
  truncated: boolean;
  nodes: SummaryNode[];
  events: NormalizedEvent[];
  sources: QueryExpansionSource[];
};

export type LcmDescription =
  | {
    target: "session";
    session: SessionSummary | undefined;
    summary: SessionMemorySummary | undefined;
    summary_nodes: SummaryNode[];
    file_refs: FileReference[];
  }
  | {
    target: "summary_node";
    node: SummaryNode;
    source_nodes: SummaryNode[];
    source_event_count: number;
  }
  | {
    target: "file_ref";
    file_ref: FileReference;
  };

export type LcmExpansion = {
  target: "summary_node";
  node: SummaryNode;
  source_nodes: SummaryNode[];
  source_events: NormalizedEvent[];
  markdown: string;
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
  session_summary_count?: number;
  summary_node_count?: number;
};

export type LcmStats = Health & {
  hook_event_counts: Record<string, number>;
  summary_nodes_by_depth: Record<string, number>;
  summary_nodes_by_source_type: Record<string, number>;
  graph_nodes_by_kind: Record<string, number>;
  graph_edges_by_kind: Record<string, number>;
  sessions_with_session_summary: number;
  sessions_with_summary_nodes: number;
  max_summary_depth: number | null;
  latest_event_at: string | null;
  latest_summary_node_at: string | null;
};

const CHECKPOINT_INTERVAL = 50;
const SUMMARY_EARLY_SIGNAL_LIMIT = 120;
const SUMMARY_LATEST_SIGNAL_LIMIT = 240;
const SUMMARY_RECENT_EVENT_LIMIT = 40;
const SUMMARY_SOURCE_HOOKS = "('UserPromptSubmit', 'Note', 'Stop', 'PreCompact', 'PostCompact')";
const KNOWN_ACYCLIC_EDGE_KINDS = new Set(["contains", "next", "tool_result", "checkpoint", "summary_source"]);
const DEFAULT_MODEL_CONTEXT_WINDOW = 128_000;
const DEFAULT_AUTO_COMPACT_TOKEN_LIMIT = 96_000;
const DEFAULT_CONTEXT_PLAN_RECENT_EVENT_LIMIT = 80;
const FILE_REF_BACKFILL_KEY = "file_refs_backfilled_v1";
const MEMORY_PROJECTION_KEY = "memory_projection_v1";

type IndexEventResult = {
  inserted: boolean;
  summaryTouched: boolean;
};

type RawReplayInspection = {
  rawIds: Set<string>;
  missingEvents: NormalizedEvent[];
  hasMemoryEvents: boolean;
  invalidMemoryEvents: Map<string, number>;
};

type SummaryRebuildStrategy = "event" | "sessions" | "deferred";

type RawEventIdCache = {
  size: number;
  mtimeMs: number;
  eventIds: Set<string>;
};

export class LcmStorage {
  readonly config: LcmConfig;
  private db?: DatabaseSync;
  private indexError?: string;
  private readonly invalidMemoryEvents = new Map<string, number>();
  private readonly readOnly: boolean;
  private readOnlyReplayInspected = false;
  private rawEventIdCache?: RawEventIdCache;

  constructor(options: StorageOptions = {}) {
    this.config = options.config ?? loadConfig({ home: options.home });
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly) {
      fs.mkdirSync(this.config.home, { recursive: true, mode: 0o700 });
    }
    if (this.readOnly && !fs.existsSync(this.config.indexPath)) {
      return;
    }
    try {
      this.db = new DatabaseSync(this.config.indexPath, { readOnly: this.readOnly, timeout: 5_000 });
      if (!this.readOnly) {
        this.initialize();
        this.invalidMemoryEvents.clear();
        this.replayRawLogToIndex();
        this.backfillGraph();
        this.backfillFileRefs();
        this.backfillSessionMemorySummaries();
      }
    } catch (error) {
      this.db = undefined;
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  close(): void {
    this.db?.close();
  }

  hasEvent(eventId: string): boolean {
    if (this.db) {
      return this.db.prepare("SELECT 1 FROM events WHERE event_id = ?1 LIMIT 1").get(eventId) !== undefined;
    }
    return readRawEvents(this.config.rawLogPath).some((event) => event.event_id === eventId);
  }

  ingest(event: NormalizedEvent): void {
    if (this.readOnly) {
      throw new Error("Cannot ingest events with read-only storage.");
    }
    try {
      this.ingestSerialized([event], "event");
    } catch (error) {
      let rawDurable: boolean;
      try {
        rawDurable = readRawEventIds(this.config.rawLogPath).has(event.event_id);
      } catch {
        throw error;
      }
      if (!rawDurable) throw error;
      this.indexError = error instanceof Error ? error.message : String(error);
      if (event.hook_event === "Memory") {
        this.replayRawLogToIndex();
        if (!this.hasEvent(event.event_id)) {
          this.db?.close();
          this.db = undefined;
        }
        throw error;
      }
    }
  }

  ingestMany(events: NormalizedEvent[], options: IngestManyOptions = {}): IngestManyResult {
    if (this.readOnly) {
      throw new Error("Cannot ingest events with read-only storage.");
    }
    return this.ingestSerialized(events, options.rebuildSummaries ?? true ? "sessions" : "deferred");
  }

  private ingestSerialized(events: NormalizedEvent[], summaryRebuild: SummaryRebuildStrategy): IngestManyResult {
    if (events.length === 0) return { imported: 0, skippedDuplicate: 0, touchedSessions: [] };
    if (events.some((event) => event.hook_event === "Memory") && !this.db) {
      throw new Error("Durable memory writes require an available index.");
    }

    if (this.db) {
      try {
        this.db.exec("BEGIN IMMEDIATE");
      } catch (error) {
        this.indexError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }

    let rawEventIds: Set<string>;
    let indexedEventIds: Set<string>;
    try {
      rawEventIds = this.readRawEventIds();
      indexedEventIds = this.db ? this.knownEventIds(events.map((event) => event.event_id)) : rawEventIds;
    } catch (error) {
      if (this.db) {
        try {
          this.db.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Bulk ingest rollback failed after raw-log read or index lookup failure.");
        }
      }
      throw error;
    }
    const rawSeen = new Set(rawEventIds);
    const indexSeen = new Set(indexedEventIds);
    const eventsToAppend: NormalizedEvent[] = [];
    const eventsToIndex: NormalizedEvent[] = [];
    let skippedDuplicate = 0;
    for (const event of events) {
      if (rawSeen.has(event.event_id)) {
        skippedDuplicate += 1;
        if (this.db && !indexSeen.has(event.event_id)) {
          indexSeen.add(event.event_id);
          eventsToIndex.push(event);
        }
        continue;
      }
      rawSeen.add(event.event_id);
      indexSeen.add(event.event_id);
      eventsToAppend.push(event);
      eventsToIndex.push(event);
    }

    try {
      this.validateMemoryEventsForAppend(eventsToAppend);
    } catch (error) {
      if (this.db) {
        try {
          this.db.exec("ROLLBACK");
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], "Bulk ingest rollback failed after memory validation failure.");
        }
      }
      throw error;
    }

    if (!this.db && eventsToAppend.length === 0 && eventsToIndex.length === 0) {
      return { imported: 0, skippedDuplicate, touchedSessions: [] };
    }

    const projectBeforeAppend = eventsToAppend.some((event) => event.hook_event === "Memory");
    if (eventsToAppend.length > 0 && !projectBeforeAppend) {
      try {
        this.appendRawEvents(eventsToAppend, rawEventIds);
      } catch (error) {
        if (this.db) {
          try {
            this.db.exec("ROLLBACK");
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], "Bulk ingest rollback failed after raw-log append failure.");
          }
        }
        throw error;
      }
    }
    if (!this.db) return { imported: eventsToAppend.length, skippedDuplicate, touchedSessions: [] };

    const touchedSessions = new Set<string>();
    try {
      for (const event of eventsToIndex) {
        const result = this.indexEventInTransaction(event, { rebuildSummary: summaryRebuild === "event" });
        if (result.summaryTouched) touchedSessions.add(event.session_id);
      }
      const rebuiltSessions = summaryRebuild === "sessions"
        ? this.rebuildTouchedSummarySessions(touchedSessions)
        : sortedSessionIds(touchedSessions);
      if (projectBeforeAppend) this.appendRawEvents(eventsToAppend, rawEventIds);
      this.db.exec("COMMIT");
      return { imported: eventsToAppend.length, skippedDuplicate, touchedSessions: rebuiltSessions };
    } catch (error) {
      let failure = error;
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) { // no-excuse-ok: catch - preserve the index failure with its rollback failure.
        failure = new AggregateError([error, rollbackError], "Bulk ingest rollback failed after indexing failure.");
      }
      this.indexError = failure instanceof Error ? failure.message : String(failure);
      throw failure;
    }
  }

  private appendRawEvents(events: readonly NormalizedEvent[], rawEventIds: Set<string>): void {
    fs.mkdirSync(path.dirname(this.config.rawLogPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.config.rawLogPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
    for (const event of events) rawEventIds.add(event.event_id);
    this.storeRawEventIds(rawEventIds);
  }

  private validateMemoryEventsForAppend(events: NormalizedEvent[]): void {
    const staged = new Map<string, DurableMemory>();
    const batchSources = new Map<string, NormalizedEvent>();
    for (const event of events) {
      if (event.hook_event === "Memory") {
        const accepted = acceptMemoryEvent(event, {
          currentMemory: (memoryId) => staged.get(memoryId) ?? this.getLatestMemory(memoryId),
          sourceEvent: (eventId) => batchSources.get(eventId) ?? this.memorySourceInIndex(eventId),
        });
        if (!accepted.accepted) throw this.memoryAppendError(accepted);
        staged.set(accepted.memory.memory_id, accepted.memory);
        continue;
      }
      batchSources.set(event.event_id, event);
    }
  }

  private memoryAppendError(accepted: Exclude<MemoryAcceptance, { readonly accepted: true }>): Error {
    const payload = accepted.payload;
    if (accepted.reason === "lineage") return new Error("Memory source event must exist in session.");
    if (payload?.operation === "create" && accepted.current) {
      return new Error(`Memory already exists: ${payload.memory_id}.`);
    }
    if (payload && payload.operation !== "create" && !accepted.current && accepted.category === "gap") {
      return new Error(`Memory not found: ${payload.memory_id}`);
    }
    if (accepted.category === "stale_expected_revision" && payload?.expected_revision !== undefined && accepted.current) {
      return new Error(`Memory revision conflict: expected ${payload.expected_revision}, current ${accepted.current.revision}.`);
    }
    return new Error(`Invalid Memory event: ${accepted.category}.`);
  }

  private readRawEventIds(): Set<string> {
    const stat = this.rawLogStat();
    const cache = this.rawEventIdCache;
    if (cache && stat && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs) {
      return cache.eventIds;
    }

    const eventIds = readRawEventIds(this.config.rawLogPath);
    if (stat) {
      this.rawEventIdCache = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        eventIds,
      };
    } else {
      this.rawEventIdCache = {
        size: 0,
        mtimeMs: 0,
        eventIds,
      };
    }
    return eventIds;
  }

  private storeRawEventIds(eventIds: Set<string>): void {
    const stat = this.rawLogStat();
    this.rawEventIdCache = stat
      ? {
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          eventIds,
        }
      : {
          size: 0,
          mtimeMs: 0,
          eventIds,
        };
  }

  private rawLogStat(): fs.Stats | undefined {
    if (!fs.existsSync(this.config.rawLogPath)) return undefined;
    return fs.statSync(this.config.rawLogPath);
  }

  rebuildSessionMemorySummaries(sessionIds: Iterable<string>): string[] {
    if (!this.db) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rebuiltSessions = this.rebuildTouchedSummarySessions(sessionIds);
      this.db.exec("COMMIT");
      return rebuiltSessions;
    } catch (error) {
      let rollbackError: unknown;
      try {
        this.db.exec("ROLLBACK");
      } catch (caught) { // no-excuse-ok: catch - report the completed rebuild failure after rollback recovery.
        rollbackError = caught;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.indexError = rollbackError === undefined ? message : `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      return [];
    }
  }

  health(): Health {
    this.inspectReadOnlyReplay();
    if (!this.db) return this.rawHealth();
    try {
      return {
        home: this.config.home,
        raw_log_path: this.config.rawLogPath,
        index_path: this.config.indexPath,
        raw_log_exists: fs.existsSync(this.config.rawLogPath),
        index_exists: fs.existsSync(this.config.indexPath),
        index_available: true,
        ...(this.indexError ?? this.memoryReplayError() ? { index_error: this.indexError ?? this.memoryReplayError() } : {}),
        event_count: Number(this.scalar("SELECT COUNT(*) AS count FROM events")),
        session_count: Number(this.scalar("SELECT COUNT(*) AS count FROM sessions")),
        graph_node_count: Number(this.scalar("SELECT COUNT(*) AS count FROM graph_nodes")),
        graph_edge_count: Number(this.scalar("SELECT COUNT(*) AS count FROM graph_edges")),
        summary_count: Number(this.scalar("SELECT COUNT(*) AS count FROM session_summaries")),
        summary_node_count: Number(this.scalar("SELECT COUNT(*) AS count FROM summary_nodes")),
      };
    } catch (error) {
      this.indexError = error instanceof Error ? error.message : String(error);
      try {
        this.db.close();
      } catch { // no-excuse-ok: catch - the storage is intentionally discarded for raw-log fallback.
        // Ignore close errors while degrading to raw JSONL health.
      }
      this.db = undefined;
      return this.rawHealth();
    }
  }

  private rawHealth(): Health {
    const rawEvents = readRawEvents(this.config.rawLogPath);
    return {
      home: this.config.home,
      raw_log_path: this.config.rawLogPath,
      index_path: this.config.indexPath,
      raw_log_exists: fs.existsSync(this.config.rawLogPath),
      index_exists: fs.existsSync(this.config.indexPath),
      index_available: false,
      ...(this.indexError ?? this.memoryReplayError() ? { index_error: this.indexError ?? this.memoryReplayError() } : {}),
      event_count: rawEvents.length,
      session_count: summarizeSessions(rawEvents).length,
    };
  }

  private inspectReadOnlyReplay(): void {
    if (!this.readOnly || this.readOnlyReplayInspected) return;
    this.readOnlyReplayInspected = true;
    if (!fs.existsSync(this.config.rawLogPath)) return;
    const rawLog = readRawLog(this.config.rawLogPath);
    this.replaceInvalidMemoryEvents(this.inspectRawReplay(rawLog.events, this.indexedEventIds()).invalidMemoryEvents);
  }

  private memoryReplayError(): string | undefined {
    if (this.invalidMemoryEvents.size === 0) return undefined;
    const categories = [...this.invalidMemoryEvents.entries()]
      .filter(([, count]) => count > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, count]) => `${category}=${count}`)
      .join(", ");
    const count = [...this.invalidMemoryEvents.values()].reduce((total, value) => total + value, 0);
    return `Ignored ${count} invalid Memory events during replay (${categories}).`;
  }

  private replayRawLogToIndex(): void {
    if (!this.db || !fs.existsSync(this.config.rawLogPath)) return;
    const rawLog = readRawLog(this.config.rawLogPath);
    const rawEvents = rawLog.events;
    const indexedIds = this.indexedEventIds();
    const inspection = this.inspectRawReplay(rawEvents, indexedIds);
    this.replaceInvalidMemoryEvents(inspection.invalidMemoryEvents);
    if (rawLog.malformedLineCount > 0) {
      const noun = rawLog.malformedLineCount === 1 ? "line" : "lines";
      this.indexError = `Raw JSONL contains ${rawLog.malformedLineCount} malformed ${noun}; destructive index reconciliation is disabled until the log is repaired.`;
    }
    if (rawEvents.length === 0) {
      if (indexedIds.size > 0 && rawLog.malformedLineCount === 0) this.rebuildIndexFromRawEvents([]);
      return;
    }
    if (inspection.hasMemoryEvents && !this.memoryProjectionReady()) {
      this.rebuildIndexFromRawEvents(rawEvents);
      return;
    }
    const hasStaleIndexedRows = [...indexedIds].some((eventId) => !inspection.rawIds.has(eventId));
    if (hasStaleIndexedRows && rawLog.malformedLineCount === 0) {
      this.rebuildIndexFromRawEvents(rawEvents);
      return;
    }
    if (inspection.missingEvents.length === 0) return;

    const touchedSessions = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of inspection.missingEvents) {
        const result = this.indexEventInTransaction(event, { rebuildSummary: false });
        if (result.summaryTouched) touchedSessions.add(event.session_id);
      }
      this.rebuildTouchedSummarySessions(touchedSessions);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch { // no-excuse-ok: catch - retain the primary replay failure for health reporting.
        // Ignore rollback failures; the original replay error is more useful.
      }
      this.indexError = error instanceof Error ? error.message : String(error);
    } finally {
      this.replaceInvalidMemoryEvents(inspection.invalidMemoryEvents);
    }
  }

  private rebuildIndexFromRawEvents(rawEvents: NormalizedEvent[]): void {
    if (!this.db) return;
    const inspection = this.inspectRawReplay(rawEvents, new Set());
    this.replaceInvalidMemoryEvents(inspection.invalidMemoryEvents);
    const touchedSessions = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.clearDerivedIndex();
      for (const event of rawEvents) {
        const result = this.indexEventInTransaction(event, { rebuildSummary: false });
        if (result.summaryTouched) touchedSessions.add(event.session_id);
      }
      if (inspection.hasMemoryEvents) this.markMemoryProjectionReady();
      this.rebuildTouchedSummarySessions(touchedSessions);
      this.db.exec("COMMIT");
    } catch (error) {
      let rollbackError: unknown;
      try {
        this.db.exec("ROLLBACK");
      } catch (caught) { // no-excuse-ok: catch - preserve the primary rebuild failure after rollback recovery.
        rollbackError = caught;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.indexError = rollbackError === undefined ? message : `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
    } finally {
      this.replaceInvalidMemoryEvents(inspection.invalidMemoryEvents);
    }
  }

  private clearDerivedIndex(): void {
    if (!this.db) return;
    this.db.prepare("DELETE FROM memory_fts").run();
    this.db.prepare("DELETE FROM memories").run();
    this.db.prepare("DELETE FROM summary_node_fts").run();
    this.db.prepare("DELETE FROM session_summary_fts").run();
    this.db.prepare("DELETE FROM event_fts").run();
    this.db.prepare("DELETE FROM summary_nodes").run();
    this.db.prepare("DELETE FROM session_summaries").run();
    this.db.prepare("DELETE FROM file_refs").run();
    this.db.prepare("DELETE FROM graph_edges").run();
    this.db.prepare("DELETE FROM graph_nodes").run();
    this.db.prepare("DELETE FROM events").run();
    this.db.prepare("DELETE FROM sessions").run();
    this.db.prepare("DELETE FROM index_metadata").run();
  }

  private knownEventIds(eventIds: string[]): Set<string> {
    const uniqueIds = Array.from(new Set(eventIds.filter(Boolean)));
    if (uniqueIds.length === 0) return new Set();
    if (!this.db) {
      const wanted = new Set(uniqueIds);
      return new Set(readRawEvents(this.config.rawLogPath)
        .map((event) => event.event_id)
        .filter((eventId) => wanted.has(eventId)));
    }

    const known = new Set<string>();
    for (const chunk of chunkArray(uniqueIds, 500)) {
      const placeholders = chunk.map((_, index) => `?${index + 1}`).join(", ");
      const rows = this.db.prepare(`SELECT event_id FROM events WHERE event_id IN (${placeholders})`).all(...chunk) as Array<{ event_id: string }>;
      for (const row of rows) known.add(row.event_id);
    }
    return known;
  }

  private indexedEventIds(): Set<string> {
    if (!this.db) return new Set();
    const rows = this.db.prepare("SELECT event_id FROM events").all() as Array<{ event_id: string }>;
    return new Set(rows.map((row) => row.event_id));
  }

  private rebuildTouchedSummarySessions(sessionIds: Iterable<string>): string[] {
    const rebuiltSessions = sortedSessionIds(sessionIds);
    for (const sessionId of rebuiltSessions) this.rebuildSessionMemorySummary(sessionId);
    return rebuiltSessions;
  }

  stats(): LcmStats {
    const health = this.health();
    if (!this.db) {
      return {
        ...health,
        hook_event_counts: countEventsByHook(readRawEvents(this.config.rawLogPath)),
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
      hook_event_counts: this.countMap(`
        SELECT hook_event AS key, COUNT(*) AS count
        FROM events
        GROUP BY hook_event
        ORDER BY hook_event
      `),
      summary_nodes_by_depth: this.countMap(`
        SELECT depth AS key, COUNT(*) AS count
        FROM summary_nodes
        GROUP BY depth
        ORDER BY depth
      `),
      summary_nodes_by_source_type: this.countMap(`
        SELECT source_type AS key, COUNT(*) AS count
        FROM summary_nodes
        GROUP BY source_type
        ORDER BY source_type
      `),
      graph_nodes_by_kind: this.countMap(`
        SELECT kind AS key, COUNT(*) AS count
        FROM graph_nodes
        GROUP BY kind
        ORDER BY kind
      `),
      graph_edges_by_kind: this.countMap(`
        SELECT kind AS key, COUNT(*) AS count
        FROM graph_edges
        GROUP BY kind
        ORDER BY kind
      `),
      session_summary_count: Number(this.scalar("SELECT COUNT(*) AS count FROM session_summaries")),
      sessions_with_session_summary: Number(this.scalar("SELECT COUNT(DISTINCT session_id) AS count FROM session_summaries")),
      sessions_with_summary_nodes: Number(this.scalar("SELECT COUNT(DISTINCT session_id) AS count FROM summary_nodes")),
      max_summary_depth: this.optionalNumberScalar("SELECT MAX(depth) AS value FROM summary_nodes"),
      latest_event_at: this.optionalStringScalar("SELECT MAX(timestamp) AS value FROM events"),
      latest_summary_node_at: this.optionalStringScalar("SELECT MAX(latest_at) AS value FROM summary_nodes"),
    };
  }

  searchSessions(args: SearchSessionArgs): SessionSummary[] {
    const limit = clampLimit(args.limit, 10);
    const excludedSessionIds = this.excludedSearchSessionIds(args);
    if (!this.db) {
      const query = args.query?.trim() ?? "";
      return summarizeSessions(readRawEvents(this.config.rawLogPath)
        .filter((event) => !args.cwd || event.cwd === args.cwd)
        .filter((event) => !args.repoRoot || event.repo_root === args.repoRoot)
        .filter((event) => !excludedSessionIds.has(event.session_id))
        .filter((event) => isSearchDiscoveryEvent(event, query))
        .filter((event) => matchesQueryText(JSON.stringify(event), query)))
        .slice(0, limit);
    }
    const query = args.query?.trim() ?? "";
    if (query.length === 0) {
      const searchLimit = excludedSessionIds.size > 0 ? Math.max(limit * 4, 20) : limit;
      return this.db.prepare(`
        SELECT session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count
        FROM sessions
        WHERE (?1 IS NULL OR cwd = ?1)
          AND (?2 IS NULL OR repo_root = ?2)
        ORDER BY last_seen DESC
        LIMIT ?3
      `).all(args.cwd ?? null, args.repoRoot ?? null, searchLimit)
        .map(rowToSessionSummary)
        .filter((session) => !excludedSessionIds.has(session.session_id))
        .slice(0, limit);
    }

    let rows: unknown[] = [];
    const eventStatement = this.db.prepare(`
        SELECT s.session_id, s.first_seen, s.last_seen, s.cwd, s.repo_root, s.git_branch, s.event_count,
               e.raw_json AS match_text, e.timestamp AS match_timestamp, 1 AS match_weight,
               'event' AS match_kind, e.event_id AS match_event_id
        FROM event_fts f
        JOIN events e ON e.event_id = f.event_id
        JOIN sessions s ON s.session_id = e.session_id
        WHERE event_fts MATCH ?1
          AND (?2 IS NULL OR s.cwd = ?2)
          AND (?3 IS NULL OR s.repo_root = ?3)
          AND e.hook_event IN ('UserPromptSubmit', 'Note', 'Stop', 'PreCompact', 'PostCompact')
        ORDER BY bm25(event_fts) ASC, e.timestamp DESC
        LIMIT ?4
      `);
    const summaryStatement = this.db.prepare(`
        SELECT s.session_id, s.first_seen, s.last_seen, s.cwd, s.repo_root, s.git_branch, s.event_count,
               ss.summary_text AS match_text, ss.updated_at AS match_timestamp, 3 AS match_weight,
               'session_summary' AS match_kind, ss.topics_json AS match_topics_json,
               ss.source_event_ids_json AS match_source_event_ids_json
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
               n.summary_text AS match_text, n.latest_at AS match_timestamp, 4 AS match_weight,
               'summary_node' AS match_kind, n.node_id AS match_node_id, n.depth AS match_depth,
               n.topics_json AS match_topics_json,
               n.source_event_ids_json AS match_source_event_ids_json,
               n.source_token_count AS match_source_token_count
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
      const candidateRows = [summaryNodeStatement, summaryStatement, eventStatement]
        .flatMap((statement) => statement.all(ftsQuery, args.cwd ?? null, args.repoRoot ?? null, Math.max(limit * 20, 50)));
      rows = candidateRows
        .filter((row) => !excludedSessionIds.has(String((row as { session_id: string }).session_id)))
        .filter((row) => isSearchDiscoveryRow(row, query));
      if (rows.length > 0) break;
    }
    return rankSessionRows(rows, query).slice(0, limit);
  }

  private excludedSearchSessionIds(args: SearchSessionArgs): Set<string> {
    const excluded = new Set(args.excludeSessionIds?.filter((sessionId) => sessionId.trim().length > 0) ?? []);
    if (args.excludeCurrentSession) {
      const currentSession = this.getCurrentSession({ cwd: args.cwd, repoRoot: args.repoRoot });
      if (currentSession) excluded.add(currentSession.session_id);
    }
    return excluded;
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

  private resolveSessionIdentifier(identifier: string): string | undefined {
    const trimmed = identifier.trim();
    if (trimmed.length === 0) return undefined;
    const direct = this.getSessionSummary(trimmed);
    if (direct) return direct.session_id;
    if (!this.db) {
      const events = readRawEvents(this.config.rawLogPath);
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.session_id === trimmed || stringField(event.payload.agent_id) === trimmed || stringField(event.payload.agentId) === trimmed) {
          return event.session_id;
        }
      }
      return undefined;
    }
    const row = this.db.prepare(`
      SELECT session_id
      FROM events
      WHERE json_extract(raw_json, '$.payload.agent_id') = ?1
         OR json_extract(raw_json, '$.payload.agentId') = ?1
      ORDER BY timestamp DESC, rowid DESC
      LIMIT 1
    `).get(trimmed) as { session_id?: string } | undefined;
    return row?.session_id;
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
    const edgeKeys = new Set(edges.map((edge) => graphEdgeKey(edge)));
    for (const edge of rawSummaryNodes.flatMap((node) => summaryGraphEdges(node, nodeIds))) {
      const key = graphEdgeKey(edge);
      if (edgeKeys.has(key)) continue;
      edgeKeys.add(key);
      edges.push(edge);
    }
    return { session_id: sessionId, nodes, edges };
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

  getContextPlan(args: {
    sessionId?: string;
    cwd?: string;
    repoRoot?: string;
    modelContextWindow?: number;
    autoCompactTokenLimit?: number;
    recentEventLimit?: number;
  } = {}): ContextPlan {
    const modelContextWindow = positiveInteger(args.modelContextWindow, DEFAULT_MODEL_CONTEXT_WINDOW);
    const autoCompactTokenLimit = Math.min(
      positiveInteger(args.autoCompactTokenLimit, DEFAULT_AUTO_COMPACT_TOKEN_LIMIT),
      modelContextWindow,
    );
    const recentEventLimit = clampLimit(args.recentEventLimit, DEFAULT_CONTEXT_PLAN_RECENT_EVENT_LIMIT, 500);
    try {
      return this.buildContextPlanForArgs(args, modelContextWindow, autoCompactTokenLimit, recentEventLimit);
    } catch (error) {
      this.indexError = error instanceof Error ? error.message : String(error);
      try {
        this.db?.close();
      } catch { // no-excuse-ok: catch - context planning intentionally falls back to raw JSONL.
        // Ignore close errors while degrading to raw JSONL context planning.
      }
      this.db = undefined;
      return this.buildContextPlanForArgs(args, modelContextWindow, autoCompactTokenLimit, recentEventLimit);
    }
  }

  private buildContextPlanForArgs(
    args: {
      sessionId?: string;
      cwd?: string;
      repoRoot?: string;
    },
    modelContextWindow: number,
    autoCompactTokenLimit: number,
    recentEventLimit: number,
  ): ContextPlan {
    const session = this.getCurrentSession({
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

    const events = this.getContextPlanEvents(session.session_id, recentEventLimit);
    const summaryStats = this.getContextPlanSummaryStats(session.session_id);
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

  recordNote(args: { sessionId: string; cwd: string; text: string }): NormalizedEvent {
    const event = createNoteEvent({
      sessionId: args.sessionId,
      cwd: args.cwd,
      text: args.text,
    });
    this.ingest(event);
    return event;
  }

  createMemory(args: CreateMemoryArgs): DurableMemory {
    const scope = args.scope === undefined ? undefined : resolveMemoryScope(args.cwd, args.scope);
    const event = createMemoryEvent({
      sessionId: args.sessionId,
      cwd: args.cwd,
      text: args.text,
      kind: args.kind,
      tags: args.tags,
      scope,
      sourceEventIds: args.sourceEventIds,
      rationale: args.rationale,
      memoryId: args.memoryId,
      repo: scope?.kind === "repo" ? { repoRoot: scope.key } : undefined,
    });
    this.ingest(event);
    return this.requireMemory(String(event.payload.memory_id));
  }

  reviseMemory(args: ReviseMemoryArgs): DurableMemory {
    if (!this.db) throw new Error("Durable memory writes require an available index.");
    const current = this.requireMemory(args.memoryId, args.cwd);
    const scope = args.scope === undefined ? current.scope : resolveMemoryScope(args.cwd, args.scope);
    const event = createMemoryEvent({
      operation: "revise",
      sessionId: args.sessionId,
      cwd: args.cwd,
      text: args.text,
      kind: args.kind ?? current.kind,
      tags: args.tags ?? current.tags,
      scope,
      sourceEventIds: args.sourceEventIds ?? current.source_event_ids,
      rationale: args.reason,
      reason: args.reason,
      expectedRevision: args.expectedRevision,
      revision: current.revision + 1,
      memoryId: args.memoryId,
      repo: scope.kind === "repo" ? { repoRoot: scope.key } : undefined,
    });
    this.ingest(event);
    return this.requireMemory(args.memoryId);
  }

  deprecateMemory(args: MemoryTransitionArgs): DurableMemory {
    return this.transitionMemory("deprecate", args);
  }

  deleteMemory(args: MemoryTransitionArgs): DurableMemory {
    return this.transitionMemory("delete", args);
  }

  private transitionMemory(operation: "deprecate" | "delete", args: MemoryTransitionArgs): DurableMemory {
    if (!this.db) throw new Error("Durable memory writes require an available index.");
    const current = this.requireMemory(args.memoryId, args.cwd);
    const event = createMemoryEvent({
      operation,
      sessionId: args.sessionId,
      cwd: args.cwd,
      kind: current.kind,
      tags: current.tags,
      scope: current.scope,
      sourceEventIds: current.source_event_ids,
      rationale: args.reason,
      reason: args.reason,
      expectedRevision: args.expectedRevision,
      revision: current.revision + 1,
      memoryId: args.memoryId,
      repo: current.scope.kind === "repo" ? { repoRoot: current.scope.key } : undefined,
    });
    this.ingest(event);
    return this.requireMemory(args.memoryId);
  }

  searchMemories(args: MemorySearchArgs = {}): DurableMemory[] {
    const query = args.query?.trim().toLocaleLowerCase() ?? "";
    const cwd = args.cwd === undefined ? undefined : path.resolve(args.cwd);
    const repoRoot = this.resolveMemoryReadRepoRoot(cwd, args.repoRoot);
    const defaultScopeKinds: DurableMemory["scope"]["kind"][] = repoRoot ? ["repo", "global"] : cwd ? ["cwd", "global"] : ["global"];
    const scopeKinds = args.scopeKinds ? defaultScopeKinds.filter((kind) => args.scopeKinds?.includes(kind)) : defaultScopeKinds;
    const allowedStatuses = new Set(args.statuses ?? ["active"]);
    const allowedKinds = args.kinds ? new Set(args.kinds) : undefined;
    const requiredTags = args.tags ? new Set(args.tags.map((tag) => tag.normalize("NFKC").trim().toLocaleLowerCase().replace(/\s+/gu, "-"))) : undefined;
    const accepts = (memory: DurableMemory): boolean =>
      allowedStatuses.has(memory.status)
      && memoryApplies(memory, cwd, repoRoot, scopeKinds)
      && (!allowedKinds || allowedKinds.has(memory.kind))
      && (!requiredTags || [...requiredTags].every((tag) => memory.tags.includes(tag)))
      && (query.length === 0 || memorySearchScore(memory, query) > 0);
    let memories: DurableMemory[] | IterableIterator<DurableMemory>;
    if (this.db && this.hasMemoryProjection() && query.length > 0) {
      const statement = this.db.prepare(`
        SELECT m.memory_id, m.revision_event_id, m.session_id, m.updated_at, m.revision, m.kind, m.scope_kind, m.scope_key,
               m.status, m.text, m.tags_json, m.provenance_json, m.source_event_ids_json
        FROM memory_fts f JOIN memories m ON m.memory_id = f.memory_id
        WHERE memory_fts MATCH ?1
      `);
      memories = [];
      for (const ftsQuery of toFtsQueries(query)) {
        const matches = statement.all(ftsQuery).map(rowToDurableMemory).filter(accepts);
        if (matches.length > 0) {
          memories = matches;
          break;
        }
      }
    } else if (this.db && this.hasMemoryProjection()) {
      memories = this.db.prepare(`
          SELECT memory_id, revision_event_id, session_id, updated_at, revision, kind, scope_kind, scope_key,
                 status, text, tags_json, provenance_json, source_event_ids_json
          FROM memories
        `).all().map(rowToDurableMemory);
    } else {
      memories = foldMemoryEvents(readRawEvents(this.config.rawLogPath)).values();
    }
    const all = Array.isArray(memories) ? memories : [...memories];
    return all
      .filter(accepts)
      .sort((left, right) => memoryScopeRank(right, cwd, repoRoot) - memoryScopeRank(left, cwd, repoRoot)
        || memorySearchScore(right, query) - memorySearchScore(left, query)
        || right.updated_at.localeCompare(left.updated_at)
        || left.memory_id.localeCompare(right.memory_id))
      .slice(0, clampLimit(args.limit, 10));
  }

  getMemory(memoryId: string, args: MemoryReadArgs = {}): MemoryDetail {
    let rawEvents: NormalizedEvent[] | undefined;
    const indexedMemory = this.getLatestMemory(memoryId);
    const memory = indexedMemory ?? foldMemoryEvents(rawEvents = readRawEvents(this.config.rawLogPath)).get(memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    const cwd = args.cwd === undefined ? undefined : path.resolve(args.cwd);
    const repoRoot = this.resolveMemoryReadRepoRoot(cwd, args.repoRoot);
    if (memory.scope.kind !== "global" && !memoryApplies(memory, cwd, repoRoot, undefined)) {
      throw new Error("Memory is not accessible from the requested scope.");
    }
    const indexedHistory = this.getIndexedMemoryRevisions(memoryId, memory, args.historyLimit, args.historyCursor);
    const history = indexedHistory?.revisions ?? memoryRevisions(rawEvents ??= readRawEvents(this.config.rawLogPath), memoryId);
    const legacyHistoryEnd = memoryHistoryEnd(args.historyCursor, history.length);
    const legacyHistoryStart = Math.max(0, legacyHistoryEnd - memoryHistoryLimit(args.historyLimit));
    const revisions = indexedHistory?.revisions ?? history.slice(legacyHistoryStart, legacyHistoryEnd);
    const includeContext = args.includeContext ?? true;
    return {
      memory,
      revisions,
      source_context: includeContext
        ? indexedHistory && this.db
          ? indexedMemorySourceContext(this.db, revisions, args.before, args.after)
          : memorySourceContext(revisions, rawEvents ??= readRawEvents(this.config.rawLogPath), args.before, args.after)
        : { events: [], sources: [] },
      ...(indexedHistory?.nextCursor !== undefined ? { next_history_cursor: indexedHistory.nextCursor } : legacyHistoryStart > 0 ? { next_history_cursor: String(legacyHistoryStart) } : {}),
    };
  }

  private resolveMemoryReadRepoRoot(cwd: string | undefined, repoRoot: string | undefined): string | undefined {
    const suppliedRepoRoot = repoRoot === undefined ? undefined : path.resolve(repoRoot);
    if (!cwd) return suppliedRepoRoot === undefined ? undefined : resolveGitMetadata(suppliedRepoRoot).repoRoot ?? suppliedRepoRoot;
    const canonicalRepoRoot = resolveGitMetadata(cwd).repoRoot;
    if (suppliedRepoRoot !== undefined && (!canonicalRepoRoot || suppliedRepoRoot !== canonicalRepoRoot)) {
      throw new Error("repoRoot must equal the canonical repository root resolved from cwd.");
    }
    return canonicalRepoRoot;
  }

  private getIndexedMemoryRevisions(memoryId: string, memory: DurableMemory, limit: number | undefined, cursor: string | undefined): { revisions: MemoryRevision[]; nextCursor?: string } | undefined {
    if (!this.db || !this.memoryProjectionReady()) return undefined;
    const historyLimit = memoryHistoryLimit(limit);
    const offset = memoryHistoryOffset(cursor);
    const rows = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE memory_id = ?1
      ORDER BY memory_revision DESC, timestamp DESC, rowid DESC
      LIMIT ?2 OFFSET ?3
    `).all(memoryId, historyLimit + 1, offset) as Array<{ raw_json: string }>;
    const page = rows.slice(0, historyLimit).flatMap((row) => {
      const revision = memoryRevisionFromAcceptedMemoryEvent(JSON.parse(row.raw_json) as NormalizedEvent, memory);
      return revision ? [revision] : [];
    }).reverse();
    return { revisions: page, ...(rows.length > historyLimit ? { nextCursor: String(offset + historyLimit) } : {}) };
  }

  private requireMemory(memoryId: string, cwd?: string): DurableMemory {
    const memory = this.getLatestMemory(memoryId);
    if (!memory) throw new Error(`Memory not found: ${memoryId}`);
    if (cwd !== undefined && !memoryApplies(memory, cwd, resolveGitMetadata(cwd).repoRoot, undefined)) {
      throw new Error("Memory is not accessible from the operation scope.");
    }
    return memory;
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

  getFileRefsForSession(sessionId: string, limit = 50): FileReference[] {
    if (!this.db) return [];
    return this.db.prepare(`
      SELECT file_ref_id, session_id, observed_event_id, timestamp, path, mime_type,
             byte_count, sha256, exploration_summary, metadata_json
      FROM file_refs
      WHERE session_id = ?1
      ORDER BY timestamp ASC, file_ref_id ASC
      LIMIT ?2
    `).all(sessionId, clampLimit(limit, 50, 500)).map(rowToFileReference);
  }

  getFileRef(fileRefId: string): FileReference | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare(`
      SELECT file_ref_id, session_id, observed_event_id, timestamp, path, mime_type,
             byte_count, sha256, exploration_summary, metadata_json
      FROM file_refs
      WHERE file_ref_id = ?1
    `).get(fileRefId);
    return row ? rowToFileReference(row) : undefined;
  }

  describeMemory(args: { sessionId?: string; nodeId?: string; fileId?: string; limit?: number }): LcmDescription {
    if (args.fileId) {
      const fileRef = this.getFileRef(args.fileId);
      if (!fileRef) throw new Error(`File reference not found: ${args.fileId}`);
      return {
        target: "file_ref",
        file_ref: fileRef,
      };
    }

    if (args.nodeId) {
      const node = this.getSummaryNode(args.nodeId);
      if (!node) throw new Error(`Summary node not found: ${args.nodeId}`);
      return {
        target: "summary_node",
        node,
        source_nodes: this.getSourceSummaryNodes(node, args.limit),
        source_event_count: node.source_event_ids.length,
      };
    }

    if (!args.sessionId) throw new Error("sessionId or nodeId is required.");
    const session = this.getSessionSummary(args.sessionId);
    const summary = this.getSessionMemorySummary(args.sessionId);
    const summaryNodes = this.getSummaryNodesForSession(args.sessionId, clampLimit(args.limit, 50, 500));
    if (!session && !summary && summaryNodes.length === 0) {
      throw new Error(`Session not found: ${args.sessionId}`);
    }
    return {
      target: "session",
      session,
      summary,
      summary_nodes: summaryNodes,
      file_refs: this.getFileRefsForSession(args.sessionId, clampLimit(args.limit, 50, 500)),
    };
  }

  expandMemory(args: { nodeId: string; query?: string; limit?: number }): LcmExpansion {
    const node = this.getSummaryNode(args.nodeId);
    if (!node) throw new Error(`Summary node not found: ${args.nodeId}`);
    const sourceNodes = this.getSourceSummaryNodes(node, args.limit);
    const sourceEvents = this.getSummaryNodeSourceEvents(node, args.query, args.limit);
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

  expandQuery(args: {
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

    let candidates = this.searchSummaryNodes({
      query,
      cwd: args.cwd,
      repoRoot: args.repoRoot,
      sessionIds: args.sessionIds,
      limit: searchLimit,
    });
    if (candidates.length === 0 && args.cwd && !args.sessionIds?.length) {
      candidates = this.searchSummaryNodes({
        query,
        repoRoot: args.repoRoot,
        limit: searchLimit,
      });
    }
    if (candidates.length === 0 && !args.sessionIds?.length) {
      const sessions = this.searchSessions({
        query,
        cwd: args.cwd,
        repoRoot: args.repoRoot,
        limit: candidateLimit,
      });
      for (const session of sessions) {
        candidates.push(...this.getTopSummaryNodesForSession(session.session_id, 1));
      }
    }

    const nodesById = new Map<string, SummaryNode>();
    const eventsById = new Map<string, NormalizedEvent>();
    const visit = (node: SummaryNode) => {
      if (nodesById.has(node.node_id) || nodesById.size >= maxNodes) return;
      nodesById.set(node.node_id, node);
      for (const event of this.getSummaryNodeSourceEvents(node, query, sourceLimit)) {
        eventsById.set(event.event_id, event);
      }
      if (node.source_type !== "nodes") return;
      const sourceNodes = rankQueryExpansionNodes(this.getSourceSummaryNodes(node, sourceLimit), query, args.overview === true);
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

  private searchSummaryNodes(args: SummaryNodeSearchArgs): SummaryNode[] {
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

  private getSourceSummaryNodes(node: SummaryNode, limit = 4): SummaryNode[] {
    if (node.source_type !== "nodes") return [];
    return node.source_ids
      .flatMap((nodeId) => this.getSummaryNode(nodeId) ?? [])
      .slice(0, clampLimit(limit, 4, 50));
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

  private getContextPlanEvents(sessionId: string, limit: number): NormalizedEvent[] {
    if (!this.db) {
      return readRawEvents(this.config.rawLogPath)
        .filter((event) => event.session_id === sessionId)
        .slice(-limit);
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
    `).all(sessionId, limit);
    return rows.map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent);
  }

  private getContextPlanSummaryStats(sessionId: string): { summaryNodeCount: number; estimatedSummaryTokens: number } {
    if (!this.db) return { summaryNodeCount: 0, estimatedSummaryTokens: 0 };
    const row = this.db.prepare(`
      SELECT COUNT(*) AS summary_node_count, COALESCE(SUM(token_count), 0) AS estimated_summary_tokens
      FROM summary_nodes
      WHERE session_id = ?1
    `).get(sessionId) as { summary_node_count?: number; estimated_summary_tokens?: number } | undefined;
    return {
      summaryNodeCount: Number(row?.summary_node_count ?? 0),
      estimatedSummaryTokens: Number(row?.estimated_summary_tokens ?? 0),
    };
  }

  packContext(args: PackContextArgs = {}): PackedContext {
    this.resolveMemoryReadRepoRoot(args.cwd, args.repoRoot);
    const budgetTokens = Math.max(16, args.budgetTokens ?? 1200);
    const budgetChars = budgetTokens * 4;
    const summaryCandidates = new Map<string, SessionMemorySummary>();
    const checkpointCandidates = new Map<string, GraphNode>();
    const summaryNodeCandidates = new Map<string, SummaryNode>();
    const query = args.query?.trim() ?? "";
    const candidateSessionIds = new Set(args.sessionIds ?? []);
    const explicitSessionIds = args.sessionIds ?? [];
    const currentThreadId = !explicitSessionIds.length ? args.currentThreadId?.trim() : undefined;
    const currentSessionId = currentThreadId ? this.resolveSessionIdentifier(currentThreadId) : undefined;
    const queryTermCount = query.length > 0 ? queryTermHitCount(query, query) : 0;

    const addSummaryNode = (node: SummaryNode) => {
      if (query.length > 0 && queryTermHitCount(summaryNodeSearchText(node), query) === 0) return;
      summaryNodeCandidates.set(node.node_id, node);
      candidateSessionIds.add(node.session_id);
    };

    const addRankedSessionNodes = (sessionId: string, limit: number): number => {
      const nodes = query.length > 0
        ? rankSummaryNodesForContext(this.getSummaryNodesForSession(sessionId, 2_000), query)
          .filter((node) => queryTermHitCount(summaryNodeSearchText(node), query) > 0)
          .slice(0, limit)
        : this.getTopSummaryNodesForSession(sessionId, limit);
      for (const node of nodes) addSummaryNode(node);
      return nodes.length;
    };

    const addSessionIfSummaryMatches = (sessionId: string): void => {
      if (query.length === 0) {
        candidateSessionIds.add(sessionId);
        return;
      }
      const summary = this.getSessionMemorySummary(sessionId);
      if (summary && queryTermHitCount(summarySearchText(summary), query) > 0) {
        candidateSessionIds.add(sessionId);
      }
    };

    if (currentSessionId) {
      const added = addRankedSessionNodes(currentSessionId, 3);
      if (added === 0) addSessionIfSummaryMatches(currentSessionId);
    }

    if (query.length > 0) {
      let nodes = this.searchSummaryNodes({
        query,
        cwd: args.cwd,
        sessionIds: explicitSessionIds,
        limit: SUMMARY_NODE_PACK_LIMIT,
      });
      if (nodes.length === 0 && args.cwd && !explicitSessionIds.length) {
        nodes = this.searchSummaryNodes({ query, limit: SUMMARY_NODE_PACK_LIMIT });
      }
      for (const node of nodes) addSummaryNode(node);

      const bestSummaryHitCount = [...summaryNodeCandidates.values()].reduce(
        (max, node) => Math.max(max, queryTermHitCount(summaryNodeSearchText(node), query)),
        0,
      );
      const hasWeakScopedMatches = args.cwd && !explicitSessionIds.length && queryTermCount >= 4 && bestSummaryHitCount <= 1;
      if (hasWeakScopedMatches) {
        const sessions = this.searchSessions({ query, limit: 8 });
        for (const session of sessions) {
          addSessionIfSummaryMatches(session.session_id);
          addRankedSessionNodes(session.session_id, 2);
        }
      }

      if (summaryNodeCandidates.size === 0 && !explicitSessionIds.length) {
        let sessions = this.searchSessions({ query, cwd: args.cwd, limit: 8 });
        if (sessions.length === 0 && args.cwd) {
          sessions = this.searchSessions({ query, limit: 8 });
        }
        for (const session of sessions) {
          candidateSessionIds.add(session.session_id);
          addRankedSessionNodes(session.session_id, 2);
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
      if (sessions.length === 0 && query.length > 0 && args.cwd && !explicitSessionIds.length) {
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
          summaryNodeExpansionToMarkdown({
            sourceNodes,
            sourceEvents,
          }),
        ].filter(Boolean).join("\n");
        const compactText = summaryNodeToCompactMarkdown(node, { sourceEvents, query });
        return { node, sourceEvents, text, compactText };
      });
    const memoryItems = this.searchMemories({ query, cwd: args.cwd, repoRoot: args.repoRoot })
      .map((memory) => ({
        memory,
        text: [
          `- [${memory.kind}] ${HISTORICAL_SOURCE_TEXT_NOTICE}`,
          quoteHistoricalText(memory.text),
          `  scope: ${memory.scope.kind}${memory.scope.kind === "global" ? "" : `:${memory.scope.key}`} | tags: ${memory.tags.join(", ") || "none"} | revision: ${memory.revision}`,
          `  provenance: ${memory.provenance.actor}:\n${quoteHistoricalText(memory.provenance.rationale)}`,
        ].join("\n"),
      }));
    const rawNoteItems = this.db ? [] : readRawEvents(this.config.rawLogPath)
      .filter((event) => event.hook_event === "Note")
      .filter((event) => !args.cwd || event.cwd === args.cwd)
      .filter((event) => !args.repoRoot || event.repo_root === args.repoRoot)
      .filter((event) => query.length === 0 || matchesQueryText(eventSearchText(event), query))
      .slice(0, 10)
      .map((event) => ({ event, text: `- ${String(event.payload.note ?? eventSearchText(event))}` }));

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

    const addMemoryItems = () => {
      if (memoryItems.length === 0) return;
      const header = "## Durable Memories\n";
      const accepted: typeof memoryItems = [];
      let memoryChars = header.length;
      for (const item of memoryItems) {
        if (chars + memoryChars + item.text.length + 1 > budgetChars) continue;
        accepted.push(item);
        memoryChars += item.text.length + 1;
      }
      if (accepted.length === 0) return;
      lines.push(header.trimEnd());
      chars += header.length;
      for (const { memory, text } of accepted) {
        lines.push(text);
        chars += text.length + 1;
        sources.push({
          kind: "memory",
          memory_id: memory.memory_id,
          session_id: memory.session_id,
          event_id: memory.revision_event_id,
          timestamp: memory.updated_at,
        });
      }
      lines.push("");
      chars += 1;
    };

    const addRawNoteItems = () => {
      if (rawNoteItems.length === 0) return;
      const header = "## Notes\n";
      const accepted: typeof rawNoteItems = [];
      let noteChars = header.length;
      for (const item of rawNoteItems) {
        if (chars + noteChars + item.text.length + 1 > budgetChars) continue;
        accepted.push(item);
        noteChars += item.text.length + 1;
      }
      if (accepted.length === 0) return;
      lines.push(header.trimEnd());
      chars += header.length;
      for (const { event, text } of accepted) {
        lines.push(text);
        chars += text.length + 1;
        sources.push({ kind: "note", session_id: event.session_id, event_id: event.event_id, timestamp: event.timestamp });
      }
      lines.push("");
      chars += 1;
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

    addRawNoteItems();
    addSummaryNodeItems();
    addMemoryItems();
    addSummaryItems();
    addCheckpointItems();

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
        memory_id TEXT,
        memory_revision INTEGER,
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
      CREATE TABLE IF NOT EXISTS memories (
        memory_id TEXT PRIMARY KEY,
        revision_event_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        kind TEXT NOT NULL,
        scope_kind TEXT NOT NULL,
        scope_key TEXT,
        status TEXT NOT NULL,
        text TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        source_event_ids_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        memory_id UNINDEXED,
        text,
        tags,
        kind,
        scope_kind,
        scope_key,
        status
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
      CREATE TABLE IF NOT EXISTS file_refs (
        file_ref_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        observed_event_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        path TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        byte_count INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        exploration_summary TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS index_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_file_refs_session_time ON file_refs(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_file_refs_path ON file_refs(path);
      CREATE INDEX IF NOT EXISTS idx_memories_scope_status_updated ON memories(scope_kind, scope_key, status, updated_at DESC);
    `);
    this.ensureColumn("events", "turn_id", "TEXT");
    this.ensureColumn("events", "tool_use_id", "TEXT");
    this.ensureColumn("events", "memory_id", "TEXT");
    this.ensureColumn("events", "memory_revision", "INTEGER");
    this.ensureColumn("session_summaries", "summary_version", "INTEGER");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_events_session_turn ON events(session_id, turn_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_tool_use ON events(session_id, tool_use_id, hook_event, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_session_hook_time ON events(session_id, hook_event, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, timestamp);
      CREATE INDEX IF NOT EXISTS idx_events_memory_history ON events(memory_id, memory_revision DESC, timestamp DESC);
    `);
  }

  private indexEventInTransaction(event: NormalizedEvent, options: { rebuildSummary: boolean }): IndexEventResult {
    if (!this.db) return { inserted: false, summaryTouched: false };
    const raw = JSON.stringify(event);
    const text = eventSearchText(event);
    const metadata = extractEventMetadata(event);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (event_id, session_id, timestamp, hook_event, cwd, repo_root, git_branch, turn_id, tool_use_id, memory_id, memory_revision, text, raw_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, ?11)
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
      return { inserted: false, summaryTouched: false };
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
    if (event.hook_event === "Memory") {
      this.projectMemoryEvent(event);
      return { inserted: true, summaryTouched: false };
    }
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
    this.indexFileRefsForEvent(event);
    const summaryTouched = isSummarySourceEvent(event);
    if (summaryTouched && options.rebuildSummary && this.shouldRebuildSessionMemorySummary(event)) {
      this.rebuildSessionMemorySummary(event.session_id);
    }
    return { inserted: true, summaryTouched };
  }

  private projectMemoryEvent(event: NormalizedEvent): void {
    const accepted = acceptMemoryEvent(event, {
      currentMemory: (memoryId) => this.getLatestMemory(memoryId),
      sourceEvent: (eventId) => this.memorySourceInIndex(eventId),
    });
    if (!accepted.accepted) {
      this.countInvalidMemory(accepted.category);
      return;
    }
    const next = accepted.memory;
    this.db?.prepare(`
      INSERT INTO memories
        (memory_id, revision_event_id, session_id, updated_at, revision, kind, scope_kind, scope_key,
         status, text, tags_json, provenance_json, source_event_ids_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
      ON CONFLICT(memory_id) DO UPDATE SET
        revision_event_id = excluded.revision_event_id,
        session_id = excluded.session_id,
        updated_at = excluded.updated_at,
        revision = excluded.revision,
        kind = excluded.kind,
        scope_kind = excluded.scope_kind,
        scope_key = excluded.scope_key,
        status = excluded.status,
        text = excluded.text,
        tags_json = excluded.tags_json,
        provenance_json = excluded.provenance_json,
        source_event_ids_json = excluded.source_event_ids_json
    `).run(
      next.memory_id,
      next.revision_event_id,
      next.session_id,
      next.updated_at,
      next.revision,
      next.kind,
      next.scope.kind,
      next.scope.kind === "global" ? null : next.scope.key,
      next.status,
      next.text,
      JSON.stringify(next.tags),
      JSON.stringify(next.provenance),
      JSON.stringify(next.source_event_ids),
    );
    this.db?.prepare("UPDATE events SET memory_id = ?1, memory_revision = ?2 WHERE event_id = ?3").run(next.memory_id, next.revision, event.event_id);
    this.markMemoryProjectionReady();
    this.db?.prepare("DELETE FROM memory_fts WHERE memory_id = ?1").run(next.memory_id);
    this.db?.prepare(`
      INSERT INTO memory_fts (memory_id, text, tags, kind, scope_kind, scope_key, status)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run(
      next.memory_id,
      next.text,
      next.tags.join(" "),
      next.kind,
      next.scope.kind,
      next.scope.kind === "global" ? "" : next.scope.key,
      next.status,
    );
  }

  private inspectRawReplay(events: readonly NormalizedEvent[], indexedIds: ReadonlySet<string>): RawReplayInspection {
    const rawIds = new Set<string>();
    const missingEvents: NormalizedEvent[] = [];
    for (const event of events) {
      rawIds.add(event.event_id);
      if (!indexedIds.has(event.event_id)) missingEvents.push(event);
    }
    const replay = replayMemoryEvents(events);
    return {
      rawIds,
      missingEvents,
      hasMemoryEvents: events.some((event) => event.hook_event === "Memory"),
      invalidMemoryEvents: replay.invalidMemoryEvents,
    };
  }

  private replaceInvalidMemoryEvents(counts: ReadonlyMap<string, number>): void {
    this.invalidMemoryEvents.clear();
    for (const [category, count] of counts) this.invalidMemoryEvents.set(category, count);
  }

  private memorySourceInIndex(eventId: string): NormalizedEvent | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare("SELECT raw_json FROM events WHERE event_id = ?1").get(eventId) as { raw_json?: string } | undefined;
    return row?.raw_json === undefined ? undefined : JSON.parse(row.raw_json) as NormalizedEvent;
  }

  private countInvalidMemory(category: string): void {
    this.invalidMemoryEvents.set(category, (this.invalidMemoryEvents.get(category) ?? 0) + 1);
  }

  private getLatestMemory(memoryId: string): DurableMemory | undefined {
    if (!this.db || !this.hasMemoryProjection()) return undefined;
    const row = this.db.prepare(`
      SELECT memory_id, revision_event_id, session_id, updated_at, revision, kind, scope_kind, scope_key,
             status, text, tags_json, provenance_json, source_event_ids_json
      FROM memories WHERE memory_id = ?1
    `).get(memoryId);
    return row ? rowToDurableMemory(row) : undefined;
  }

  private hasMemoryProjection(): boolean {
    return this.db?.prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = 'memories' LIMIT 1").get() !== undefined
      && this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'memory_fts' LIMIT 1").get() !== undefined;
  }

  private memoryProjectionReady(): boolean {
    return this.hasMemoryProjection()
      && this.db?.prepare("SELECT value FROM index_metadata WHERE key = ?1 LIMIT 1").get(MEMORY_PROJECTION_KEY)?.value === "2";
  }

  private markMemoryProjectionReady(): void {
    this.db?.prepare("INSERT INTO index_metadata (key, value) VALUES (?1, '2') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(MEMORY_PROJECTION_KEY);
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

  private indexFileRefsForEvent(event: NormalizedEvent): void {
    if (!this.db) return;
    const refs = extractFileReferences(event);
    for (const ref of refs) {
      this.db.prepare(`
        INSERT INTO file_refs
          (file_ref_id, session_id, observed_event_id, timestamp, path, mime_type,
           byte_count, sha256, exploration_summary, metadata_json)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        ON CONFLICT(file_ref_id) DO UPDATE SET
          session_id = excluded.session_id,
          observed_event_id = excluded.observed_event_id,
          timestamp = excluded.timestamp,
          path = excluded.path,
          mime_type = excluded.mime_type,
          byte_count = excluded.byte_count,
          sha256 = excluded.sha256,
          exploration_summary = excluded.exploration_summary,
          metadata_json = excluded.metadata_json
      `).run(
        ref.file_ref_id,
        ref.session_id,
        ref.observed_event_id,
        ref.timestamp,
        ref.path,
        ref.mime_type,
        ref.byte_count,
        ref.sha256,
        ref.exploration_summary,
        JSON.stringify(ref.metadata),
      );
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
    if (fromNodeId === toNodeId || (!KNOWN_ACYCLIC_EDGE_KINDS.has(kind) && this.wouldCreateCycle(fromNodeId, toNodeId))) {
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
      } catch { // no-excuse-ok: catch - retain the primary graph-backfill failure for health reporting.
        // Ignore rollback failures; the original backfill error is more useful.
      }
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  private backfillFileRefs(): void {
    if (!this.db) return;
    const marker = this.db.prepare("SELECT value FROM index_metadata WHERE key = ?1").get(FILE_REF_BACKFILL_KEY) as { value?: string } | undefined;
    if (marker?.value === "1") return;
    const rows = this.db.prepare(`
      SELECT raw_json
      FROM events
      WHERE hook_event = 'PostToolUse'
        AND (
          raw_json LIKE '%file_path%'
          OR raw_json LIKE '%filepath%'
          OR raw_json LIKE '%absolute_path%'
          OR raw_json LIKE '%filename%'
          OR raw_json LIKE '%"path"%'
          OR raw_json LIKE '%"file"%'
        )
      ORDER BY timestamp ASC, rowid ASC
    `).all();

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const event = JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent;
        this.indexFileRefsForEvent(event);
      }
      this.db.prepare(`
        INSERT INTO index_metadata (key, value)
        VALUES (?1, '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(FILE_REF_BACKFILL_KEY);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch { // no-excuse-ok: catch - retain the primary file-reference backfill failure for health reporting.
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
      } catch { // no-excuse-ok: catch - retain the primary summary-backfill failure for health reporting.
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

  private optionalNumberScalar(sql: string): number | null {
    if (!this.db) return null;
    const row = this.db.prepare(sql).get() as { value?: unknown };
    return typeof row.value === "number" ? row.value : null;
  }

  private optionalStringScalar(sql: string): string | null {
    if (!this.db) return null;
    const row = this.db.prepare(sql).get() as { value?: unknown };
    return typeof row.value === "string" && row.value.length > 0 ? row.value : null;
  }

  private countMap(sql: string): Record<string, number> {
    if (!this.db) return {};
    const rows = this.db.prepare(sql).all() as Array<{ key: unknown; count: unknown }>;
    return Object.fromEntries(rows.map((row) => [String(row.key), Number(row.count)]));
  }

  private shouldRebuildSessionMemorySummary(event: NormalizedEvent): boolean {
    if (!this.db || !isSummarySourceEvent(event)) return false;
    if (event.hook_event !== "UserPromptSubmit") return true;
    const existingSummary = this.db.prepare("SELECT 1 FROM session_summaries WHERE session_id = ?1 LIMIT 1").get(event.session_id);
    if (!existingSummary) return true;
    const highSignalCount = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM events
      WHERE session_id = ?1
        AND hook_event IN ${SUMMARY_SOURCE_HOOKS}
    `).get(event.session_id)?.count ?? 0);
    const chunkOffset = highSignalCount % SUMMARY_NODE_CHUNK_SIZE;
    return chunkOffset === 0 || chunkOffset === 1;
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
    this.db.prepare("DELETE FROM graph_edges WHERE session_id = ?1 AND kind = 'summary_source'").run(sessionId);
    if (sourceEvents.length === 0) return;

    let previousDepth = chunkArray(sourceEvents, SUMMARY_NODE_CHUNK_SIZE)
      .map((events) => buildLeafSummaryNode(events));
    const nodes: SummaryNode[] = [];
    for (const node of previousDepth) this.insertSummaryNode(node);
    nodes.push(...previousDepth);

    for (let depth = 1; depth <= SUMMARY_NODE_MAX_DEPTH && previousDepth.length > 1; depth += 1) {
      const condensed = chunkArray(previousDepth, SUMMARY_NODE_FANOUT)
        .map((nodes) => buildCondensedSummaryNode(nodes, depth));
      for (const node of condensed) this.insertSummaryNode(node);
      nodes.push(...condensed);
      previousDepth = condensed;
    }
    for (const node of nodes) this.insertSummarySourceEdges(node);
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

  private insertSummarySourceEdges(node: SummaryNode): void {
    for (const [index, sourceId] of node.source_ids.entries()) {
      this.insertGraphEdge(
        node.node_id,
        node.source_type === "events" ? eventNodeId(sourceId) : sourceId,
        "summary_source",
        node.session_id,
        index,
        node.created_at,
        {
          depth: node.depth,
          source_type: node.source_type,
        },
      );
    }
  }

  private getAllSummarySourceEventsForSession(sessionId: string): NormalizedEvent[] {
    if (!this.db) return [];
    const rows = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE session_id = ?1
        AND hook_event IN ('UserPromptSubmit', 'Note', 'Stop', 'PreCompact', 'PostCompact')
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId);
    return rows
      .map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent)
      .filter((event) => !isCodexLcmToolEvent(event))
      .filter(isSummarySourceEvent);
  }

  private getSummaryEventsForSession(sessionId: string): NormalizedEvent[] {
    if (!this.db) return [];
    const earlySignals = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE session_id = ?1
        AND hook_event IN ${SUMMARY_SOURCE_HOOKS}
      ORDER BY timestamp ASC, rowid ASC
      LIMIT ?2
    `).all(sessionId, SUMMARY_EARLY_SIGNAL_LIMIT);
    const latestSignals = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE session_id = ?1
        AND hook_event IN ${SUMMARY_SOURCE_HOOKS}
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
      .filter((event) => !isCodexLcmToolEvent(event))
      .filter((event) => !isGeneratedSuggestionEvent(event)))
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

function rowToFileReference(row: unknown): FileReference {
  const record = row as Record<string, unknown>;
  return {
    file_ref_id: String(record.file_ref_id),
    session_id: String(record.session_id),
    observed_event_id: String(record.observed_event_id),
    timestamp: String(record.timestamp),
    path: String(record.path),
    mime_type: String(record.mime_type),
    byte_count: Number(record.byte_count),
    sha256: String(record.sha256),
    exploration_summary: String(record.exploration_summary),
    metadata: parseMetadata(record.metadata_json),
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

function graphEdgeKey(edge: Pick<GraphEdge, "from_node_id" | "to_node_id" | "kind">): string {
  return `${edge.from_node_id}\0${edge.to_node_id}\0${edge.kind}`;
}

function rankSessionRows(rows: unknown[], query: string): SessionSummary[] {
  const evidenceRows = strongestSessionEvidenceRows(rows, query);
  const sessions = new Map<string, {
    summary: SessionSummary;
    score: number;
    matchCount: number;
    lastMatchAt: string;
    firstOrder: number;
    bestMatch?: SessionSearchMatch;
  }>();
  evidenceRows.forEach((row, order) => {
    const record = row as Record<string, unknown>;
    const sessionId = String(record.session_id);
    const matchAt = String(record.match_timestamp ?? record.last_seen ?? "");
    const matchText = typeof record.match_text === "string" ? record.match_text : "";
    const weight = typeof record.match_weight === "number" ? record.match_weight : 1;
    const rowScore = queryTermHitCount(matchText, query) * weight;
    const bestMatch = rowToSessionSearchMatch(record, query, rowScore);
    const existing = sessions.get(sessionId);
    if (!existing) {
      sessions.set(sessionId, {
        summary: rowToSessionSummary(row),
        score: rowScore,
        matchCount: 1,
        lastMatchAt: matchAt,
        firstOrder: order,
        bestMatch,
      });
      return;
    }
    existing.score += rowScore;
    existing.matchCount += 1;
    if (matchAt > existing.lastMatchAt) existing.lastMatchAt = matchAt;
    if (bestMatch && (!existing.bestMatch || compareSearchMatches(bestMatch, existing.bestMatch) < 0)) {
      existing.bestMatch = bestMatch;
    }
  });
  return [...sessions.values()]
    .map((entry) => ({
      ...entry,
      discovery: sessionDiscovery(entry, query),
    }))
    .sort((a, b) =>
      b.discovery.score - a.discovery.score ||
      b.score - a.score ||
      (b.bestMatch?.score ?? 0) - (a.bestMatch?.score ?? 0) ||
      b.matchCount - a.matchCount ||
      b.lastMatchAt.localeCompare(a.lastMatchAt) ||
      a.firstOrder - b.firstOrder)
    .map((entry) => ({
      ...entry.summary,
      match_count: entry.matchCount,
      ...(entry.bestMatch ? { best_match: entry.bestMatch } : {}),
      discovery: entry.discovery,
    }));
}

function strongestSessionEvidenceRows(rows: unknown[], query: string): unknown[] {
  const scores = new Map<string, Map<SessionSearchMatch["kind"], { score: number; matchCount: number }>>();
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const kind = searchMatchKind(record.match_kind);
    if (!kind) continue;
    const sessionId = String(record.session_id);
    const sessionScores = scores.get(sessionId) ?? new Map();
    const evidence = sessionScores.get(kind) ?? { score: 0, matchCount: 0 };
    const matchText = typeof record.match_text === "string" ? record.match_text : "";
    const weight = typeof record.match_weight === "number" ? record.match_weight : 1;
    evidence.score += queryTermHitCount(matchText, query) * weight;
    evidence.matchCount += 1;
    sessionScores.set(kind, evidence);
    scores.set(sessionId, sessionScores);
  }

  const selectedKinds = new Map<string, SessionSearchMatch["kind"]>();
  for (const [sessionId, sessionScores] of scores) {
    const selected = [...sessionScores.entries()].sort((left, right) =>
      right[1].score - left[1].score ||
      right[1].matchCount - left[1].matchCount ||
      searchMatchKindWeight(right[0]) - searchMatchKindWeight(left[0]))[0];
    if (selected) selectedKinds.set(sessionId, selected[0]);
  }

  return rows.filter((row) => {
    const record = row as Record<string, unknown>;
    return selectedKinds.get(String(record.session_id)) === searchMatchKind(record.match_kind);
  });
}

function sessionDiscovery(entry: {
  summary: SessionSummary;
  score: number;
  matchCount: number;
  bestMatch?: SessionSearchMatch;
}, query: string): SessionDiscovery {
  let score = entry.score;
  const reasons: string[] = [];
  const match = entry.bestMatch;

  if (match?.kind === "summary_node") {
    score += 10;
    reasons.push("summary-node match");
  } else if (match?.kind === "session_summary") {
    score += 6;
    reasons.push("session-summary match");
  } else if (match?.kind === "event") {
    reasons.push("raw-event match");
  }

  const sourceEventCount = match?.source_event_count ?? 0;
  if (sourceEventCount >= 4) {
    score += 12;
    reasons.push("source-rich summary");
  } else if (sourceEventCount >= 2) {
    score += 6;
    reasons.push("multiple source events");
  }

  const sourceTokenCount = match?.source_token_count ?? 0;
  if (sourceTokenCount >= 600) {
    score += 8;
    reasons.push("substantive source text");
  } else if (sourceTokenCount >= 160) {
    score += 4;
    reasons.push("nontrivial source text");
  }

  if (entry.summary.event_count >= 8) {
    score += 8;
    reasons.push("longer session");
  } else if (entry.summary.event_count >= 3) {
    score += 4;
    reasons.push("multi-event session");
  } else if (entry.summary.event_count >= 2) {
    score += 2;
    reasons.push("prompt-outcome session");
  }

  if (entry.matchCount >= 2) {
    score += Math.min(entry.matchCount, 4) * 2;
    reasons.push("multiple matches");
  }

  if (isBroadDiscoveryQuery(query) && entry.summary.event_count <= 1) {
    score -= 24;
    reasons.push("tiny session penalty");
  }

  const confidence = score >= 34 ? "high" : score >= 18 ? "medium" : "low";
  return {
    confidence,
    score,
    reasons,
  };
}

function isSearchDiscoveryRow(row: unknown, query: string): boolean {
  const record = row as Record<string, unknown>;
  if (searchMatchKind(record.match_kind) !== "event") return true;
  if (typeof record.match_text !== "string") return true;
  try {
    return isSearchDiscoveryEvent(JSON.parse(record.match_text) as NormalizedEvent, query);
  } catch {
    return true;
  }
}

function isSearchDiscoveryEvent(event: NormalizedEvent, query: string): boolean {
  if (isGeneratedSuggestionEvent(event)) return isExplicitSuggestionQuery(query);
  return isSummarySourceEvent(event);
}

function isExplicitSuggestionQuery(query: string): boolean {
  return /\b(hyperpersonalized|suggestion|suggestions)\b/iu.test(query);
}

function isBroadDiscoveryQuery(query: string): boolean {
  return discoveryQueryTermCount(query) >= 4;
}

function discoveryQueryTermCount(query: string): number {
  const terms = new Set<string>();
  for (const term of query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const normalized = term.replace(/^-+|-+$/gu, "");
    if (normalized.length >= 3 || /[-_]/u.test(normalized) || /\d/u.test(normalized)) {
      terms.add(normalized);
    }
  }
  return terms.size;
}

function rowToSessionSearchMatch(record: Record<string, unknown>, query: string, score: number): SessionSearchMatch | undefined {
  const kind = searchMatchKind(record.match_kind);
  if (!kind) return undefined;
  const text = searchMatchText(kind, record.match_text);
  const snippet = bestMatchSnippet(text, query);
  if (snippet.length === 0) return undefined;
  const topics = parseStringArray(record.match_topics_json);
  const sourceEventCount = parseStringArray(record.match_source_event_ids_json).length;
  const sourceTokenCount = Number(record.match_source_token_count ?? 0);
  return {
    kind,
    snippet,
    timestamp: String(record.match_timestamp ?? ""),
    score,
    ...(typeof record.match_node_id === "string" && record.match_node_id.length > 0 ? { node_id: record.match_node_id } : {}),
    ...(typeof record.match_event_id === "string" && record.match_event_id.length > 0 ? { event_id: record.match_event_id } : {}),
    ...(record.match_depth !== undefined ? { depth: Number(record.match_depth) } : {}),
    ...(topics.length > 0 ? { topics: topics.slice(0, 12) } : {}),
    ...(sourceEventCount > 0 ? { source_event_count: sourceEventCount } : {}),
    ...(sourceTokenCount > 0 ? { source_token_count: sourceTokenCount } : {}),
  };
}

function searchMatchKind(value: unknown): SessionSearchMatch["kind"] | undefined {
  if (value === "summary_node" || value === "session_summary" || value === "event") return value;
  return undefined;
}

function searchMatchText(kind: SessionSearchMatch["kind"], value: unknown): string {
  if (typeof value !== "string") return "";
  if (kind !== "event") return value;
  try {
    const event = JSON.parse(value) as NormalizedEvent;
    return eventSignalText(event) || `${event.hook_event}: ${JSON.stringify(event.payload)}`;
  } catch {
    return value;
  }
}

function compareSearchMatches(a: SessionSearchMatch, b: SessionSearchMatch): number {
  return b.score - a.score ||
    searchMatchKindWeight(b.kind) - searchMatchKindWeight(a.kind) ||
    b.timestamp.localeCompare(a.timestamp);
}

function searchMatchKindWeight(kind: SessionSearchMatch["kind"]): number {
  if (kind === "summary_node") return 3;
  if (kind === "session_summary") return 2;
  return 1;
}

function bestMatchSnippet(text: string, query: string, maxChars = 220): string {
  const compactText = compactWhitespace(text);
  if (compactText.length === 0) return "";
  const scoredLines = text.split(/\r?\n/u)
    .map(compactWhitespace)
    .filter((line) => line.length > 0)
    .map((line, index) => ({ line, index, hits: queryTermHitCount(line, query) }));
  const candidates = scoredLines.some((line) => line.hits > 0 && !line.line.startsWith("Topics:"))
    ? scoredLines.filter((line) => line.hits > 0 && !line.line.startsWith("Topics:"))
    : scoredLines;
  const bestLine = candidates
    .sort((a, b) => b.hits - a.hits || a.index - b.index)[0]?.line ?? compactText;
  return truncateSnippet(bestLine, maxChars);
}

function truncateSnippet(text: string, maxChars: number): string {
  const compact = compactWhitespace(text);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
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
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? Object.fromEntries(Object.entries(parsed)) : {};
  } catch { // no-excuse-ok: catch - invalid persisted metadata is safely treated as empty.
    return {};
  }
}

function parseStringArray(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { // no-excuse-ok: catch - invalid persisted arrays are safely treated as empty.
    return [];
  }
}

function clampLimit(limit: number | undefined, fallback: number, max = 200): number {
  return Math.min(Math.max(Number(limit ?? fallback), 1), max);
}

function positiveInteger(value: number | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

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

function readRawLog(rawLogPath: string): { events: NormalizedEvent[]; malformedLineCount: number } {
  if (!fs.existsSync(rawLogPath)) return { events: [], malformedLineCount: 0 };
  const events: NormalizedEvent[] = [];
  let malformedLineCount = 0;
  for (const line of fs.readFileSync(rawLogPath, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    try {
      events.push(JSON.parse(line) as NormalizedEvent);
    } catch {
      malformedLineCount += 1;
    }
  }
  return { events, malformedLineCount };
}

function readRawEvents(rawLogPath: string): NormalizedEvent[] {
  return readRawLog(rawLogPath).events;
}

function readRawEventIds(rawLogPath: string): Set<string> {
  return new Set(readRawEvents(rawLogPath).map((event) => event.event_id));
}

function countEventsByHook(events: NormalizedEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const event of events) {
    counts[event.hook_event] = (counts[event.hook_event] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
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

function sortedSessionIds(sessionIds: Iterable<string>): string[] {
  return Array.from(new Set(sessionIds)).sort((left, right) => left.localeCompare(right));
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
