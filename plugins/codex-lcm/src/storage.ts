import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { loadConfig, type LcmConfig } from "./config.ts";
import { decodePersistedEvent } from "./event-codec.ts";
import { createNoteEvent, type NormalizedEvent } from "./events.ts";
import { extractFileReferences, type FileReference } from "./file-refs.ts";
import type { OverflowReference, OverflowSearchMatch } from "./overflow.ts";
import {
  appendRawEvents,
  rawLogState,
  rawLogStat,
  readRawEventIds,
  readRawEvents,
  readRawLog,
  RawLogLockTimeoutError,
  withRawLogLock,
  type RawLogState,
} from "./raw-log.ts";
import { initializeStorageSchema } from "./storage-schema.ts";
import {
  describeMemory as describeStoredMemory,
  eventSearchText,
  expandMemory as expandStoredMemory,
  expandQuery as expandStoredQuery,
  getContextPlan as readContextPlan,
  getFileRef as readFileRef,
  getFileRefsForSession as readFileRefsForSession,
  getOverflowRef as readOverflowRef,
  getRecentContext as readRecentContext,
  packContext as packStoredContext,
  parseCursor,
  parseTimestamp,
} from "./storage-context.ts";
import {
  derivedGraphEdgeCounts,
  derivedGraphNodeCounts,
  getStoredSessionGraph,
} from "./storage-graph.ts";
import {
  clampLimit,
  searchStoredOverflow,
  searchStoredSessions,
} from "./storage-search.ts";
import {
  getSessionMemorySummary as readSessionMemorySummary,
  getSummaryBackfillSessionIds,
  getSummaryNodesForSession as readSummaryNodesForSession,
  rebuildSessionMemorySummary as materializeSessionMemorySummary,
  shouldRebuildSessionMemorySummary as shouldMaterializeSessionMemorySummary,
} from "./storage-summaries.ts";
import {
  extractEventMetadata,
  extractSessionMetadata,
  getCurrentStoredSession,
  getStoredSession,
  isCodexLcmToolEvent,
  isSearchIndexEvent,
  listStoredSessions,
  maxNullable,
  scalar,
  sortedSessionIds,
  storageStats,
  storedUsage,
  summarizeSessions,
} from "./storage-sessions.ts";
import {
  SUMMARY_ALGORITHM_VERSION,
  SUMMARY_NODE_VERSION,
  isSummarySourceEvent,
  type SessionMemorySummary,
  type SummaryNode,
} from "./summary.ts";

export type {
  ContextPlan, ContextPlanState, GraphEdge, GraphNode, Health, IndexCleanupReport, IngestManyOptions,
  IngestManyResult, LcmDescription, LcmExpansion, LcmQueryExpansion, LcmStats, ListSessionsArgs, PackedContext,
  PackContextArgs, QueryExpansionSource, RecentContext, SearchOverflowArgs, SearchSessionArgs, SessionDetail,
  SessionDiscovery, SessionGraph, SessionListSummary, SessionPage, SessionSearchMatch, SessionSummary,
  StorageOptions, UsageReport,
} from "./storage-types.ts";
export type { FileReference, OverflowContent, OverflowReference, OverflowSearchMatch, SessionMemorySummary, SummaryNode, SummarySourceType } from "./storage-types.ts";

import type { StorageOptions, IngestManyResult, IngestManyOptions, SearchSessionArgs, SearchOverflowArgs, ListSessionsArgs, SessionPage, UsageReport, IndexCleanupReport, SessionSummary, SessionDetail, RecentContext, ContextPlan, PackedContext, PackContextArgs, LcmQueryExpansion, LcmDescription, LcmExpansion, SessionGraph, Health, LcmStats } from "./storage-types.ts";

const SUMMARY_SOURCE_HOOKS = "('UserPromptSubmit', 'Note', 'Stop', 'PreCompact', 'PostCompact')";
const FILE_REF_BACKFILL_KEY = "file_refs_backfilled_v1";
const DELEGATION_PARENT_BACKFILL_KEY = "delegation_parent_backfilled_v1";
const EVENT_METADATA_BACKFILL_KEY = "event_metadata_backfilled_v1";
const RAW_LOG_INDEX_STATE_KEY = "raw_log_index_state_v1";

type IndexEventResult = {
  inserted: boolean;
  summaryTouched: boolean;
};

type SummaryRebuildStrategy = "event" | "sessions" | "deferred";

type RawEventIdCache = {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  eventIds: Set<string>;
};

class DerivedIndexError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DerivedIndexError";
  }
}

export class LcmStorage {
  readonly config: LcmConfig;
  private db?: DatabaseSync;
  private indexError?: string;
  private readonly readOnly: boolean;
  private rawEventIdCache?: RawEventIdCache;

  constructor(options: StorageOptions = {}) {
    this.config = options.config ?? loadConfig({ home: options.home });
    this.readOnly = options.readOnly ?? false;
    if (!this.readOnly) {
      fs.mkdirSync(this.config.home, { recursive: true, mode: 0o700 });
      fs.chmodSync(this.config.home, 0o700);
    }
    if (this.readOnly && !fs.existsSync(this.config.indexPath)) {
      return;
    }
    try {
      this.db = new DatabaseSync(this.config.indexPath, { readOnly: this.readOnly, timeout: 5_000 });
      if (!this.readOnly) {
        fs.chmodSync(this.config.indexPath, 0o600);
        this.initialize();
        this.replayRawLogToIndex();
        this.backfillDelegationParents();
        this.backfillFileRefs();
        this.backfillSessionMemorySummaries();
      }
    } catch (error) {
      this.db = undefined;
      if (error instanceof RawLogLockTimeoutError) throw error;
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
      if (!(error instanceof DerivedIndexError)) throw error;
      let rawDurable: boolean;
      try {
        rawDurable = readRawEventIds(this.config.rawLogPath).has(event.event_id);
      } catch {
        throw error;
      }
      if (!rawDurable) throw error;
      this.indexError = error instanceof Error ? error.message : String(error);
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
    let indexedRawLogState: string | undefined;
    let indexedEventIds = new Set<string>();
    try {
      if (this.db && this.indexError) this.replayRawLogToIndex();
      if (this.db) {
        indexedRawLogState = this.indexedRawLogState();
        indexedEventIds = this.knownEventIds(events.map((event) => event.event_id));
      }
    } catch (error) {
      if (error instanceof RawLogLockTimeoutError) throw error;
      this.indexError = error instanceof Error ? error.message : String(error);
      indexedRawLogState = undefined;
    }
    const rawWrite = withRawLogLock(this.config.rawLogPath, () => {
      const rawLogWasIndexed = indexedRawLogState === JSON.stringify(this.rawLogState());
      const rawEventIds = rawLogWasIndexed ? indexedEventIds : this.readRawEventIds();

      const rawSeen = new Set(rawEventIds);
      const eventsToAppend: NormalizedEvent[] = [];
      let skippedDuplicate = 0;
      for (const event of events) {
        if (rawSeen.has(event.event_id)) {
          skippedDuplicate += 1;
          continue;
        }
        rawSeen.add(event.event_id);
        eventsToAppend.push(event);
      }

      if (eventsToAppend.length > 0) {
        appendRawEvents(this.config.rawLogPath, eventsToAppend);
        this.storeRawEventIds(rawSeen);
      }
      return {
        eventsToAppend,
        rawLogState: rawLogWasIndexed ? this.rawLogState() : undefined,
        skippedDuplicate,
      };
    });
    if (!this.db) return { imported: rawWrite.eventsToAppend.length, skippedDuplicate: rawWrite.skippedDuplicate, touchedSessions: [] };

    try {
      this.db.exec("BEGIN IMMEDIATE");
    } catch (error) {
      const failure = new DerivedIndexError(error);
      this.indexError = failure.message;
      throw failure;
    }

    const touchedSessions = new Set<string>();
    try {
      const indexSeen = this.knownEventIds(events.map((event) => event.event_id));
      for (const event of events) {
        if (indexSeen.has(event.event_id)) continue;
        indexSeen.add(event.event_id);
        const result = this.indexEventInTransaction(event, { rebuildSummary: summaryRebuild === "event" });
        if (result.summaryTouched) touchedSessions.add(event.session_id);
      }
      const rebuiltSessions = summaryRebuild === "sessions"
        ? this.rebuildTouchedSummarySessions(touchedSessions)
        : sortedSessionIds(touchedSessions);
      if (rawWrite.rawLogState) this.recordRawLogState(rawWrite.rawLogState);
      this.db.exec("COMMIT");
      if (rawWrite.rawLogState) this.indexError = undefined;
      return {
        imported: rawWrite.eventsToAppend.length,
        skippedDuplicate: rawWrite.skippedDuplicate,
        touchedSessions: rebuiltSessions,
      };
    } catch (error) {
      let failure = error;
      try {
        this.db.exec("ROLLBACK");
      } catch (rollbackError) {
        failure = new AggregateError([error, rollbackError], "Bulk ingest rollback failed after indexing failure.");
      }
      const indexFailure = new DerivedIndexError(failure);
      this.indexError = indexFailure.message;
      throw indexFailure;
    }
  }

  private readRawEventIds(): Set<string> {
    const stat = this.rawLogStat();
    const cache = this.rawEventIdCache;
    if (cache && stat && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs && cache.ctimeMs === stat.ctimeMs) {
      return cache.eventIds;
    }

    const eventIds = readRawEventIds(this.config.rawLogPath);
    if (stat) {
      this.rawEventIdCache = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        eventIds,
      };
    } else {
      this.rawEventIdCache = {
        size: 0,
        mtimeMs: 0,
        ctimeMs: 0,
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
          ctimeMs: stat.ctimeMs,
          eventIds,
        }
      : {
          size: 0,
          mtimeMs: 0,
          ctimeMs: 0,
          eventIds,
        };
  }

  private rawLogStat(): fs.Stats | undefined {
    return rawLogStat(this.config.rawLogPath);
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
      } catch (caught) {
        rollbackError = caught;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.indexError = rollbackError === undefined ? message : `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
      return [];
    }
  }

  cleanupIndex(options: { apply?: boolean } = {}): IndexCleanupReport {
    if (!this.db && !fs.existsSync(this.config.rawLogPath) && !fs.existsSync(this.config.indexPath)) {
      return {
        applied: false,
        raw_log_preserved: true,
        index_path: this.config.indexPath,
        database_bytes_before: 0,
        database_bytes_after: 0,
        event_fts_rows_before: 0,
        event_fts_rows_after: 0,
        projected_event_fts_rows: 0,
        event_text_bytes_before: 0,
        event_text_bytes_after: 0,
        projected_summaries_to_rebuild: 0,
        summaries_rebuilt: 0,
        vacuumed: false,
      };
    }
    if (!this.db) throw new Error("SQLite index is unavailable; the raw event log was not changed.");
    const apply = options.apply === true;
    if (apply && this.readOnly) throw new Error("Cleanup --apply requires writable storage.");

    const inspectIndex = () => {
      const searchableEvents = (this.db!.prepare(`
        SELECT raw_json
        FROM events
        WHERE hook_event IN ${SUMMARY_SOURCE_HOOKS}
        ORDER BY timestamp ASC, rowid ASC
      `).all() as Array<{ raw_json: string }>)
        .map((row) => decodePersistedEvent(row.raw_json))
        .filter(isSearchIndexEvent)
        .filter((event) => !isCodexLcmToolEvent(event));
      const summarySessionIds = new Set(searchableEvents
        .filter(isSummarySourceEvent)
        .map((event) => event.session_id));
      return {
        databaseBytesBefore: fileSize(this.config.indexPath),
        eventFtsRowsBefore: scalar(this.db, "SELECT COUNT(*) AS count FROM event_fts"),
        eventTextBytesBefore: scalar(this.db, "SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS count FROM events"),
        searchableEvents,
        sessionIds: this.outdatedSummarySessionIds()
          .filter((sessionId) => summarySessionIds.has(sessionId)),
      };
    };

    if (!apply) {
      const inspection = inspectIndex();
      return {
        applied: false,
        raw_log_preserved: true,
        index_path: this.config.indexPath,
        database_bytes_before: inspection.databaseBytesBefore,
        database_bytes_after: inspection.databaseBytesBefore,
        event_fts_rows_before: inspection.eventFtsRowsBefore,
        event_fts_rows_after: inspection.eventFtsRowsBefore,
        projected_event_fts_rows: inspection.searchableEvents.length,
        event_text_bytes_before: inspection.eventTextBytesBefore,
        event_text_bytes_after: inspection.eventTextBytesBefore,
        projected_summaries_to_rebuild: inspection.sessionIds.length,
        summaries_rebuilt: 0,
        vacuumed: false,
      };
    }

    this.db.exec("BEGIN IMMEDIATE");
    let inspection: ReturnType<typeof inspectIndex>;
    try {
      inspection = inspectIndex();
      this.db.prepare("DELETE FROM event_fts").run();
      const insertSearchEvent = this.db.prepare(`
        INSERT INTO event_fts (event_id, session_id, cwd, repo_root, hook_event, content)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `);
      for (const event of inspection.searchableEvents) {
        insertSearchEvent.run(
          event.event_id,
          event.session_id,
          event.cwd,
          event.repo_root ?? "",
          event.hook_event,
          eventSearchText(event),
        );
      }
      this.db.prepare("UPDATE events SET text = '' WHERE text <> ''").run();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original cleanup failure.
      }
      throw error;
    }

    for (const sessionBatch of chunkArray(inspection.sessionIds, 10)) {
      this.reopenWritableIndex();
      this.db?.exec("BEGIN IMMEDIATE");
      try {
        for (const sessionId of sessionBatch) this.rebuildSessionMemorySummary(sessionId);
        this.db?.exec("COMMIT");
      } catch (error) {
        try {
          this.db?.exec("ROLLBACK");
        } catch {
          // Preserve the original summary rebuild failure.
        }
        throw error;
      }
    }

    this.db.exec("INSERT INTO event_fts(event_fts) VALUES('optimize')");
    this.db.exec("INSERT INTO session_summary_fts(session_summary_fts) VALUES('optimize')");
    this.db.exec("INSERT INTO summary_node_fts(summary_node_fts) VALUES('optimize')");
    this.db.exec("PRAGMA optimize");
    this.db.exec("VACUUM");
    return {
      applied: true,
      raw_log_preserved: true,
      index_path: this.config.indexPath,
      database_bytes_before: inspection.databaseBytesBefore,
      database_bytes_after: fileSize(this.config.indexPath),
      event_fts_rows_before: inspection.eventFtsRowsBefore,
      event_fts_rows_after: scalar(this.db, "SELECT COUNT(*) AS count FROM event_fts"),
      projected_event_fts_rows: inspection.searchableEvents.length,
      event_text_bytes_before: inspection.eventTextBytesBefore,
      event_text_bytes_after: scalar(this.db, "SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS count FROM events"),
      projected_summaries_to_rebuild: inspection.sessionIds.length,
      summaries_rebuilt: inspection.sessionIds.length,
      vacuumed: true,
    };
  }

  private reopenWritableIndex(): void {
    this.db?.close();
    this.db = new DatabaseSync(this.config.indexPath, { timeout: 5_000 });
  }

  private outdatedSummarySessionIds(): string[] {
    if (!this.db) return [];
    return (this.db.prepare(`
      SELECT s.session_id
      FROM sessions s
      LEFT JOIN session_summaries ss ON ss.session_id = s.session_id
      LEFT JOIN (
        SELECT session_id, MAX(summary_version) AS summary_node_version
        FROM summary_nodes
        GROUP BY session_id
      ) sn ON sn.session_id = s.session_id
      WHERE EXISTS (
        SELECT 1 FROM events e
        WHERE e.session_id = s.session_id
          AND e.hook_event IN ${SUMMARY_SOURCE_HOOKS}
      )
        AND (
          ss.session_id IS NULL
          OR ss.summary_version IS NULL
          OR ss.summary_version < ${SUMMARY_ALGORITHM_VERSION}
          OR sn.summary_node_version IS NULL
          OR sn.summary_node_version < ${SUMMARY_NODE_VERSION}
        )
      ORDER BY s.session_id ASC
    `).all() as Array<{ session_id: string }>).map((row) => row.session_id);
  }

  health(): Health {
    if (!this.db) return this.rawHealth();
    try {
      const graphNodeCounts = derivedGraphNodeCounts(this.db);
      const graphEdgeCounts = derivedGraphEdgeCounts(this.db);
      return {
        home: this.config.home,
        raw_log_path: this.config.rawLogPath,
        index_path: this.config.indexPath,
        raw_log_exists: fs.existsSync(this.config.rawLogPath),
        index_exists: fs.existsSync(this.config.indexPath),
        index_available: true,
        ...(this.indexError ? { index_error: this.indexError } : {}),
        event_count: scalar(this.db, "SELECT COUNT(*) AS count FROM events"),
        session_count: scalar(this.db, "SELECT COUNT(*) AS count FROM sessions"),
        graph_node_count: sumCounts(graphNodeCounts),
        graph_edge_count: sumCounts(graphEdgeCounts),
        summary_count: scalar(this.db, "SELECT COUNT(*) AS count FROM session_summaries"),
        summary_node_count: scalar(this.db, "SELECT COUNT(*) AS count FROM summary_nodes"),
      };
    } catch (error) {
      this.indexError = error instanceof Error ? error.message : String(error);
      try {
        this.db.close();
      } catch {
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
      ...(this.indexError ? { index_error: this.indexError } : {}),
      event_count: rawEvents.length,
      session_count: summarizeSessions(rawEvents).length,
    };
  }

  private replayRawLogToIndex(): void {
    if (!this.db) return;
    if (this.rawLogIsIndexed()) return;
    const snapshot = withRawLogLock(this.config.rawLogPath, () => ({
      rawLog: readRawLog(this.config.rawLogPath),
      state: this.rawLogState(),
    }));
    const rawLog = snapshot.rawLog;
    const rawEvents = rawLog.events;
    const indexedEvents = this.indexedEventsById();
    const indexedIds = new Set(indexedEvents.keys());
    if (rawLog.malformedLineCount > 0) {
      const noun = rawLog.malformedLineCount === 1 ? "line" : "lines";
      this.indexError = `Raw JSONL contains ${rawLog.malformedLineCount} malformed ${noun}; destructive index reconciliation is disabled until the log is repaired.`;
    }
    if (rawEvents.length === 0) {
      if (indexedIds.size > 0 && rawLog.malformedLineCount === 0) this.rebuildIndexFromRawEvents([], snapshot.state);
      else if (rawLog.malformedLineCount === 0) this.recordRawLogState(snapshot.state);
      return;
    }
    const rawIds = new Set(rawEvents.map((event) => event.event_id));
    const hasStaleIndexedRows = [...indexedIds].some((eventId) => !rawIds.has(eventId));
    const hasChangedIndexedRows = rawEvents.some((event) => {
      const indexedRaw = indexedEvents.get(event.event_id);
      return indexedRaw !== undefined && indexedRaw !== JSON.stringify(event);
    });
    if ((hasStaleIndexedRows || hasChangedIndexedRows) && rawLog.malformedLineCount === 0) {
      this.rebuildIndexFromRawEvents(rawEvents, snapshot.state);
      return;
    }
    const missingEvents = rawEvents.filter((event) => !indexedIds.has(event.event_id));
    if (missingEvents.length === 0) {
      if (rawLog.malformedLineCount === 0) this.recordRawLogState(snapshot.state);
      return;
    }

    const touchedSessions = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const event of missingEvents) {
        const result = this.indexEventInTransaction(event, { rebuildSummary: false });
        if (result.summaryTouched) touchedSessions.add(event.session_id);
      }
      this.rebuildTouchedSummarySessions(touchedSessions);
      if (rawLog.malformedLineCount === 0) this.recordRawLogState(snapshot.state);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Ignore rollback failures; the original replay error is more useful.
      }
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  private rebuildIndexFromRawEvents(rawEvents: NormalizedEvent[], state: RawLogState): void {
    if (!this.db) return;
    const touchedSessions = new Set<string>();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.clearDerivedIndex();
      for (const event of rawEvents) {
        const result = this.indexEventInTransaction(event, { rebuildSummary: false });
        if (result.summaryTouched) touchedSessions.add(event.session_id);
      }
      this.rebuildTouchedSummarySessions(touchedSessions);
      this.recordRawLogState(state);
      this.db.exec("COMMIT");
    } catch (error) {
      let rollbackError: unknown;
      try {
        this.db.exec("ROLLBACK");
      } catch (caught) {
        rollbackError = caught;
      }
      const message = error instanceof Error ? error.message : String(error);
      this.indexError = rollbackError === undefined ? message : `${message}; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
    }
  }

  private clearDerivedIndex(): void {
    if (!this.db) return;
    this.db.prepare("DELETE FROM summary_node_fts").run();
    this.db.prepare("DELETE FROM session_summary_fts").run();
    this.db.prepare("DELETE FROM event_fts").run();
    this.db.prepare("DELETE FROM summary_nodes").run();
    this.db.prepare("DELETE FROM session_summaries").run();
    this.db.prepare("DELETE FROM file_refs").run();
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

  private indexedEventsById(): Map<string, string> {
    if (!this.db) return new Map();
    const rows = this.db.prepare("SELECT event_id, raw_json FROM events").all() as Array<{ event_id: string; raw_json: string }>;
    return new Map(rows.map((row) => [row.event_id, row.raw_json]));
  }

  private rawLogIsIndexed(): boolean {
    if (!this.db) return false;
    return this.indexedRawLogState() === JSON.stringify(this.rawLogState());
  }

  private indexedRawLogState(): string | undefined {
    if (!this.db) return undefined;
    const row = this.db.prepare("SELECT value FROM index_metadata WHERE key = ?1").get(RAW_LOG_INDEX_STATE_KEY) as { value?: string } | undefined;
    return row?.value;
  }

  private recordRawLogState(state: RawLogState): void {
    if (!this.db) return;
    this.db.prepare(`
      INSERT INTO index_metadata (key, value)
      VALUES (?1, ?2)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(RAW_LOG_INDEX_STATE_KEY, JSON.stringify(state));
  }

  private rawLogState(): RawLogState {
    return rawLogState(this.config.rawLogPath);
  }

  private rebuildTouchedSummarySessions(sessionIds: Iterable<string>): string[] {
    const rebuiltSessions = sortedSessionIds(sessionIds);
    for (const sessionId of rebuiltSessions) this.rebuildSessionMemorySummary(sessionId);
    return rebuiltSessions;
  }

  stats(): LcmStats {
    const health = this.health();
    return storageStats(
      this.db,
      this.config.rawLogPath,
      health,
      derivedGraphNodeCounts(this.db),
      derivedGraphEdgeCounts(this.db),
    );
  }

  listSessions(args: ListSessionsArgs = {}): SessionPage {
    const limit = clampLimit(args.limit, 50, 500);
    const offset = parseCursor(args.cursor);
    const since = parseTimestamp(args.since, "since");
    const until = parseTimestamp(args.until, "until");
    return listStoredSessions(this.db, this.config.rawLogPath, args, limit, offset, since, until);
  }

  usage(args: Omit<ListSessionsArgs, "limit" | "cursor"> = {}): UsageReport {
    const since = parseTimestamp(args.since, "since");
    const until = parseTimestamp(args.until, "until");
    return storedUsage(this.db, this.config.rawLogPath, args, since, until);
  }

  searchSessions(args: SearchSessionArgs): SessionSummary[] {
    return searchStoredSessions(this.db, this.config.rawLogPath, args);
  }

  searchOverflow(args: SearchOverflowArgs): OverflowSearchMatch[] {
    return searchStoredOverflow(this.db, this.config.rawLogPath, this.config.overflowDir, args);
  }

  getCurrentSession(args: { sessionId?: string; cwd?: string; repoRoot?: string } = {}): SessionSummary | undefined {
    return getCurrentStoredSession(this.db, this.config.rawLogPath, args);
  }

  getSession(sessionId: string, args: { limit?: number; cursor?: string } = {}): SessionDetail {
    const offset = parseCursor(args.cursor);
    const limit = args.limit === undefined ? undefined : clampLimit(args.limit, 200);
    return getStoredSession(this.db, this.config.rawLogPath, sessionId, limit, offset);
  }

  getSessionGraph(sessionId: string, args: { limit?: number } = {}): SessionGraph {
    const limit = clampLimit(args.limit, 200, 1_000);
    return getStoredSessionGraph(this.db, this.config.rawLogPath, sessionId, limit);
  }

  getRecentContext(args: { sessionId?: string; cwd?: string; repoRoot?: string; limit?: number } = {}): RecentContext {
    return readRecentContext(this.db, this.config.rawLogPath, args);
  }

  getContextPlan(args: {
    sessionId?: string;
    cwd?: string;
    repoRoot?: string;
    modelContextWindow?: number;
    autoCompactTokenLimit?: number;
    recentEventLimit?: number;
  } = {}): ContextPlan {
    try {
      return readContextPlan(this.db, this.config.rawLogPath, args);
    } catch (error) {
      this.indexError = error instanceof Error ? error.message : String(error);
      try {
        this.db?.close();
      } catch {
        // Ignore close errors while degrading to raw JSONL context planning.
      }
      this.db = undefined;
      return readContextPlan(this.db, this.config.rawLogPath, args);
    }
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
    return readSessionMemorySummary(this.db, this.config.rawLogPath, sessionId);
  }

  getSummaryNodesForSession(sessionId: string, limit = 200): SummaryNode[] {
    return readSummaryNodesForSession(this.db, sessionId, limit);
  }

  getFileRefsForSession(sessionId: string, limit = 50): FileReference[] {
    return readFileRefsForSession(this.db, sessionId, limit);
  }

  getFileRef(fileRefId: string): FileReference | undefined {
    return readFileRef(this.db, fileRefId);
  }

  getOverflowRef(fileRefId: string): OverflowReference | undefined {
    return readOverflowRef(this.db, this.config.rawLogPath, fileRefId);
  }

  describeMemory(args: {
    sessionId?: string;
    nodeId?: string;
    fileId?: string;
    limit?: number;
    offset?: number;
    maxBytes?: number;
  }): LcmDescription {
    return describeStoredMemory(this.db, this.config.rawLogPath, this.config.overflowDir, args);
  }

  expandMemory(args: { nodeId: string; query?: string; limit?: number }): LcmExpansion {
    return expandStoredMemory(this.db, args);
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
    return expandStoredQuery(this.db, this.config.rawLogPath, args);
  }

  packContext(args: PackContextArgs = {}): PackedContext {
    return packStoredContext(this.db, this.config.rawLogPath, args);
  }

  private initialize(): void {
    if (!this.db) return;
    const { backfillSessionMetadata } = initializeStorageSchema(this.db);
    this.backfillExistingEventMetadata();
    if (backfillSessionMetadata) this.backfillExistingSessionMetadata();
  }

  private indexEventInTransaction(event: NormalizedEvent, options: { rebuildSummary: boolean }): IndexEventResult {
    if (!this.db) return { inserted: false, summaryTouched: false };
    const raw = JSON.stringify(event);
    const metadata = extractEventMetadata(event);
    const sessionMetadata = extractSessionMetadata(event);
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
      "",
      raw,
    );
    if ((insert as { changes?: number }).changes === 0) {
      return { inserted: false, summaryTouched: false };
    }
    this.db.prepare(`
      INSERT INTO sessions
        (session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count,
         parent_session_id, agent_role, agent_nickname, model, reasoning_effort,
         total_input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens, total_tokens)
      VALUES (?1, ?2, ?2, ?3, ?4, ?5, 1, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)
      ON CONFLICT(session_id) DO UPDATE SET
        first_seen = CASE WHEN excluded.first_seen < sessions.first_seen THEN excluded.first_seen ELSE sessions.first_seen END,
        last_seen = CASE WHEN excluded.last_seen > sessions.last_seen THEN excluded.last_seen ELSE sessions.last_seen END,
        cwd = excluded.cwd,
        repo_root = COALESCE(excluded.repo_root, sessions.repo_root),
        git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
        parent_session_id = COALESCE(excluded.parent_session_id, sessions.parent_session_id),
        agent_role = COALESCE(excluded.agent_role, sessions.agent_role),
        agent_nickname = COALESCE(excluded.agent_nickname, sessions.agent_nickname),
        model = COALESCE(excluded.model, sessions.model),
        reasoning_effort = COALESCE(excluded.reasoning_effort, sessions.reasoning_effort),
        total_input_tokens = ${maxNullable("sessions.total_input_tokens", "excluded.total_input_tokens")},
        cached_input_tokens = ${maxNullable("sessions.cached_input_tokens", "excluded.cached_input_tokens")},
        output_tokens = ${maxNullable("sessions.output_tokens", "excluded.output_tokens")},
        reasoning_output_tokens = ${maxNullable("sessions.reasoning_output_tokens", "excluded.reasoning_output_tokens")},
        total_tokens = ${maxNullable("sessions.total_tokens", "excluded.total_tokens")},
        event_count = sessions.event_count + 1
    `).run(
      event.session_id,
      event.timestamp,
      event.cwd,
      event.repo_root ?? null,
      event.git_branch ?? null,
      sessionMetadata.parent_session_id ?? null,
      sessionMetadata.agent_role ?? null,
      sessionMetadata.agent_nickname ?? null,
      sessionMetadata.model ?? null,
      sessionMetadata.reasoning_effort ?? null,
      sessionMetadata.total_input_tokens ?? null,
      sessionMetadata.cached_input_tokens ?? null,
      sessionMetadata.output_tokens ?? null,
      sessionMetadata.reasoning_output_tokens ?? null,
      sessionMetadata.total_tokens ?? null,
    );
    if (isSearchIndexEvent(event) && !isCodexLcmToolEvent(event)) {
      this.db.prepare(`
        INSERT INTO event_fts (event_id, session_id, cwd, repo_root, hook_event, content)
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
      `).run(
        event.event_id,
        event.session_id,
        event.cwd,
        event.repo_root ?? "",
        event.hook_event,
        eventSearchText(event),
      );
    }
    this.indexFileRefsForEvent(event);
    const summaryTouched = isSummarySourceEvent(event);
    if (summaryTouched && options.rebuildSummary && this.shouldRebuildSessionMemorySummary(event)) {
      this.rebuildSessionMemorySummary(event.session_id);
    }
    return { inserted: true, summaryTouched };
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

  private backfillExistingEventMetadata(): void {
    if (!this.db) return;
    const marker = this.db.prepare("SELECT value FROM index_metadata WHERE key = ?1")
      .get(EVENT_METADATA_BACKFILL_KEY) as { value?: string } | undefined;
    if (marker?.value === "1") return;
    const rows = this.db.prepare("SELECT raw_json FROM events").all() as Array<{ raw_json: string }>;
    const update = this.db.prepare("UPDATE events SET turn_id = ?1, tool_use_id = ?2 WHERE event_id = ?3");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const event = decodePersistedEvent(row.raw_json);
        const metadata = extractEventMetadata(event);
        update.run(metadata.turn_id ?? null, metadata.tool_use_id ?? null, event.event_id);
      }
      this.db.prepare(`
        INSERT INTO index_metadata (key, value)
        VALUES (?1, '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(EVENT_METADATA_BACKFILL_KEY);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the metadata backfill failure.
      }
      throw error;
    }
  }

  private backfillExistingSessionMetadata(): void {
    if (!this.db) return;
    const rows = this.db.prepare("SELECT raw_json FROM events WHERE hook_event = 'SessionStart'").all() as Array<{ raw_json: string }>;
    const update = this.db.prepare(`
      UPDATE sessions SET parent_session_id = ?2, agent_role = ?3, agent_nickname = ?4 WHERE session_id = ?1
    `);
    for (const row of rows) {
      const event = decodePersistedEvent(row.raw_json);
      const metadata = extractSessionMetadata(event);
      update.run(event.session_id, metadata.parent_session_id ?? null, metadata.agent_role ?? null, metadata.agent_nickname ?? null);
    }
  }

  private backfillDelegationParents(): void {
    if (!this.db) return;
    const marker = this.db.prepare("SELECT value FROM index_metadata WHERE key = ?1").get(DELEGATION_PARENT_BACKFILL_KEY) as { value?: string } | undefined;
    if (marker?.value === "1") return;
    const rows = this.db.prepare(`
      SELECT e.raw_json
      FROM events e
      JOIN sessions s ON s.session_id = e.session_id
      WHERE e.hook_event = 'UserPromptSubmit'
        AND s.parent_session_id IS NULL
      ORDER BY e.timestamp ASC, e.rowid ASC
    `).all() as Array<{ raw_json: string }>;
    const update = this.db.prepare(`
      UPDATE sessions
      SET parent_session_id = ?2
      WHERE session_id = ?1 AND parent_session_id IS NULL
    `);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const event = decodePersistedEvent(row.raw_json);
        const parentId = extractSessionMetadata(event).parent_session_id;
        if (parentId && parentId !== event.session_id) update.run(event.session_id, parentId);
      }
      this.db.prepare(`
        INSERT INTO index_metadata (key, value)
        VALUES (?1, '1')
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(DELEGATION_PARENT_BACKFILL_KEY);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original backfill failure.
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
        const event = decodePersistedEvent((row as { raw_json: string }).raw_json);
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
      } catch {
        // Ignore rollback failures; the original backfill error is more useful.
      }
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  private backfillSessionMemorySummaries(): void {
    if (!this.db) return;
    const sessionIds = getSummaryBackfillSessionIds(this.db);
    if (sessionIds.length === 0) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const sessionId of sessionIds) this.rebuildSessionMemorySummary(sessionId);
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

  private shouldRebuildSessionMemorySummary(event: NormalizedEvent): boolean {
    return shouldMaterializeSessionMemorySummary(this.db, event);
  }

  private rebuildSessionMemorySummary(sessionId: string): void {
    materializeSessionMemorySummary(this.db, sessionId);
  }
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

export function createStorage(options: StorageOptions = {}): LcmStorage {
  return new LcmStorage(options);
}

function fileSize(filePath: string): number {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

function chunkArray<T>(values: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
