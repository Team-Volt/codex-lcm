import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { loadConfig, type LcmConfig } from "./config.ts";
import { createNoteEvent, type NormalizedEvent } from "./events.ts";
import type { FileReference } from "./file-refs.ts";
import type { OverflowReference, OverflowSearchMatch } from "./overflow.ts";
import {
  appendRawEvents,
  readRawEventIds,
  readRawEvents,
  readRawLog,
  RawLogLockTimeoutError,
  withRawLogLock,
  type RawLogState,
} from "./raw-log.ts";
import {
  describeMemory as describeStoredMemory,
  expandMemory as expandStoredMemory,
  expandQuery as expandStoredQuery,
  getContextPlan as readContextPlan,
  getFileRef as readFileRef,
  getFileRefsForSession as readFileRefsForSession,
  getOverflowRef as readOverflowRef,
  getRecentContext as readRecentContext,
  parseCursor,
  parseTimestamp,
} from "./storage-context.ts";
import { packContext as packStoredContext } from "./storage-pack.ts";
import {
  derivedGraphEdgeCounts,
  derivedGraphNodeCounts,
  getStoredSessionGraph,
} from "./storage-graph.ts";
import {
  DerivedIndexError,
  appliedCleanupReport,
  backfillDelegationParents as runDelegationParentBackfill,
  backfillFileRefs as runFileRefBackfill,
  backfillSessionMemorySummaries as runSummaryBackfill,
  cacheRawEventIds,
  clearDerivedIndex as clearStoredDerivedIndex,
  currentRawLogState,
  emptyCleanupReport,
  indexedEventsById as readIndexedEventsById,
  indexedRawLogState as readIndexedRawLogState,
  indexEventInTransaction as indexStoredEventInTransaction,
  initializeIndex,
  inspectIndexForCleanup,
  isRawLogIndexed,
  knownEventIds as readKnownEventIds,
  optimizeIndex,
  previewCleanupReport,
  rawHealth as readRawHealth,
  readCachedRawEventIds,
  recordRawLogState as storeRawLogState,
  replaceCleanupSearchIndex,
  rollbackPreservingError,
  writableIndexHealth,
  type IndexEventResult,
  type RawEventIdCache,
} from "./storage-persistence.ts";
import {
  clampLimit,
  searchStoredOverflow,
  searchStoredSessions,
} from "./storage-search.ts";
import {
  getSessionMemorySummary as readSessionMemorySummary,
  getSummaryNodesForSession as readSummaryNodesForSession,
  rebuildSessionMemorySummary as materializeSessionMemorySummary,
} from "./storage-summaries.ts";
import {
  getCurrentStoredSession,
  getStoredSession,
  listStoredSessions,
  sortedSessionIds,
  storageStats,
  storedUsage,
} from "./storage-sessions.ts";
import {
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

type SummaryRebuildStrategy = "event" | "sessions" | "deferred";

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
      this.indexError = error instanceof Error ? error.message : String(error);
      throw new DerivedIndexError(error);
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
      const rollback = rollbackPreservingError(this.db, error);
      if (rollback.kind !== "rolled_back") {
        failure = new AggregateError([rollback.original, rollback.rollbackError], "Bulk ingest rollback failed after indexing failure.");
      }
      this.indexError = failure instanceof Error ? failure.message : String(failure);
      throw new DerivedIndexError(failure);
    }
  }

  private readRawEventIds(): Set<string> {
    const result = readCachedRawEventIds(this.config.rawLogPath, this.rawEventIdCache);
    this.rawEventIdCache = result.cache;
    return result.eventIds;
  }

  private storeRawEventIds(eventIds: Set<string>): void {
    this.rawEventIdCache = cacheRawEventIds(this.config.rawLogPath, eventIds);
  }

  rebuildSessionMemorySummaries(sessionIds: Iterable<string>): string[] {
    if (!this.db) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rebuiltSessions = this.rebuildTouchedSummarySessions(sessionIds);
      this.db.exec("COMMIT");
      return rebuiltSessions;
    } catch (error) {
      const rollback = rollbackPreservingError(this.db, error);
      const message = error instanceof Error ? error.message : String(error);
      this.indexError = rollback.kind === "rolled_back" ? message : `${message}; rollback failed: ${rollback.rollbackError instanceof Error ? rollback.rollbackError.message : String(rollback.rollbackError)}`;
      return [];
    }
  }

  cleanupIndex(options: { apply?: boolean } = {}): IndexCleanupReport {
    if (!this.db && !fs.existsSync(this.config.rawLogPath) && !fs.existsSync(this.config.indexPath)) {
      return emptyCleanupReport(this.config.indexPath);
    }
    if (!this.db) throw new Error("SQLite index is unavailable; the raw event log was not changed.");
    const apply = options.apply === true;
    if (apply && this.readOnly) throw new Error("Cleanup --apply requires writable storage.");
    if (!apply) {
      return previewCleanupReport(this.config.indexPath, inspectIndexForCleanup(this.db, this.config.indexPath));
    }
    this.db.exec("BEGIN IMMEDIATE");
    let inspection: ReturnType<typeof inspectIndexForCleanup>;
    try {
      inspection = inspectIndexForCleanup(this.db, this.config.indexPath);
      replaceCleanupSearchIndex(this.db, inspection.searchableEvents);
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        throw error;
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
          throw error;
        }
        throw error;
      }
    }
    optimizeIndex(this.db);
    return appliedCleanupReport(this.db, this.config.indexPath, inspection);
  }

  private reopenWritableIndex(): void {
    this.db?.close();
    this.db = new DatabaseSync(this.config.indexPath, { timeout: 5_000 });
  }

  health(): Health {
    if (!this.db) return this.rawHealth();
    try {
      return writableIndexHealth(
        this.db,
        this.config,
        this.indexError,
        derivedGraphNodeCounts(this.db),
        derivedGraphEdgeCounts(this.db),
      );
    } catch (error) {
      this.indexError = error instanceof Error ? error.message : String(error);
      try {
        this.db.close();
      } catch {
        this.db = undefined;
        return this.rawHealth();
      }
      this.db = undefined;
      return this.rawHealth();
    }
  }

  private rawHealth(): Health {
    return readRawHealth(this.config, this.indexError);
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
      const failure = rollbackPreservingError(this.db, error).original;
      this.indexError = failure instanceof Error ? failure.message : String(failure);
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
      const rollback = rollbackPreservingError(this.db, error);
      const message = error instanceof Error ? error.message : String(error);
      this.indexError = rollback.kind === "rolled_back" ? message : `${message}; rollback failed: ${rollback.rollbackError instanceof Error ? rollback.rollbackError.message : String(rollback.rollbackError)}`;
    }
  }

  private clearDerivedIndex(): void {
    if (this.db) clearStoredDerivedIndex(this.db);
  }

  private knownEventIds(eventIds: string[]): Set<string> {
    return readKnownEventIds(this.db, this.config.rawLogPath, eventIds);
  }

  private indexedEventsById(): Map<string, string> {
    return this.db ? readIndexedEventsById(this.db) : new Map();
  }

  private rawLogIsIndexed(): boolean {
    return this.db ? isRawLogIndexed(this.db, this.config.rawLogPath) : false;
  }

  private indexedRawLogState(): string | undefined {
    return this.db ? readIndexedRawLogState(this.db) : undefined;
  }

  private recordRawLogState(state: RawLogState): void {
    if (this.db) storeRawLogState(this.db, state);
  }

  private rawLogState(): RawLogState {
    return currentRawLogState(this.config.rawLogPath);
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
        this.db = undefined;
        return readContextPlan(this.db, this.config.rawLogPath, args);
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
    if (this.db) initializeIndex(this.db);
  }

  private indexEventInTransaction(event: NormalizedEvent, options: { rebuildSummary: boolean }): IndexEventResult {
    return indexStoredEventInTransaction(this.db, event, options.rebuildSummary);
  }

  private backfillDelegationParents(): void {
    this.indexError = runDelegationParentBackfill(this.db) ?? this.indexError;
  }

  private backfillFileRefs(): void {
    this.indexError = runFileRefBackfill(this.db) ?? this.indexError;
  }

  private backfillSessionMemorySummaries(): void {
    this.indexError = runSummaryBackfill(this.db) ?? this.indexError;
  }

  private rebuildSessionMemorySummary(sessionId: string): void {
    materializeSessionMemorySummary(this.db, sessionId);
  }
}

export function createStorage(options: StorageOptions = {}): LcmStorage {
  return new LcmStorage(options);
}

function chunkArray<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}
