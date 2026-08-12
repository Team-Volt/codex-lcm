import fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";

import type { LcmConfig } from "./config.ts";
import { decodePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";
import { extractFileReferences } from "./file-refs.ts";
import { overflowReferenceFromEvent } from "./overflow.ts";
import { rawLogState, rawLogStat, readRawEventIds, readRawEvents, segmentedRawLogState, type RawEventLocation, type RawLogState } from "./raw-log.ts";
import { eventSearchText } from "./storage-context.ts";
import { recordValue, rowToSessionMemorySummary, rowToSummaryNode } from "./storage-rows.ts";
import { createSearchIndexTables, initializeStorageSchema } from "./storage-schema.ts";
import { segmentStorageHealth } from "./raw-segments.ts";
import { STORED_EVENT_JSON_SQL } from "./stored-event.ts";
import { getSummaryBackfillSessionIds, rebuildSessionMemorySummary, shouldRebuildSessionMemorySummary } from "./storage-summaries.ts";
import { extractEventMetadata, extractSessionMetadata, isCodexLcmToolEvent, isSearchIndexEvent, maxNullable, scalar, summarizeSessions } from "./storage-sessions.ts";
import type { Health, IndexCleanupReport } from "./storage-types.ts";
import {
  SUMMARY_ALGORITHM_VERSION,
  SUMMARY_NODE_VERSION,
  isSummarySourceEvent,
  summaryNodeSearchText,
  summarySearchText,
} from "./summary.ts";

const SUMMARY_SOURCE_HOOKS = "('UserPromptSubmit', 'Note', 'Stop', 'PreCompact', 'PostCompact')";
const FILE_REF_BACKFILL_KEY = "file_refs_backfilled_v1";
const DELEGATION_PARENT_BACKFILL_KEY = "delegation_parent_backfilled_v1";
const EVENT_METADATA_BACKFILL_KEY = "event_metadata_backfilled_v1";
const EVENT_LOCATOR_METADATA_BACKFILL_KEY = "event_locator_metadata_backfilled_v1";
const RAW_LOG_INDEX_STATE_KEY = "raw_log_index_state_v1";
export const SEARCH_INDEX_VACUUM_KEY = "search_index_vacuum_v1";

export type IndexEventResult = { readonly inserted: boolean; readonly summaryTouched: boolean };
export type RawEventIdCache = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly eventIds: Set<string>;
};
type RawEventIdRead = { readonly eventIds: Set<string>; readonly cache: RawEventIdCache };
export type CleanupInspection = {
  readonly databaseBytesBefore: number;
  readonly eventFtsRowsBefore: number;
  readonly eventTextBytesBefore: number;
  readonly searchableEvents: readonly NormalizedEvent[];
  readonly sessionIds: readonly string[];
};
type RollbackResult =
  | { readonly kind: "rolled_back"; readonly original: unknown }
  | { readonly kind: "error"; readonly original: unknown; readonly rollbackError: Error }
  | { readonly kind: "unknown"; readonly original: unknown; readonly rollbackError: unknown };

export class DerivedIndexError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "DerivedIndexError";
  }
}

export function rollbackPreservingError(db: DatabaseSync | undefined, original: unknown): RollbackResult {
  try {
    db?.exec("ROLLBACK");
    return { kind: "rolled_back", original };
  } catch (rollbackError) {
    if (rollbackError instanceof Error) return { kind: "error", original, rollbackError };
    return { kind: "unknown", original, rollbackError };
  }
}

export function readCachedRawEventIds(rawLogPath: string, cache: RawEventIdCache | undefined): RawEventIdRead {
  const stat = rawLogStat(rawLogPath);
  if (cache && stat && cache.size === stat.size && cache.mtimeMs === stat.mtimeMs && cache.ctimeMs === stat.ctimeMs) {
    return { eventIds: cache.eventIds, cache };
  }
  const eventIds = readRawEventIds(rawLogPath);
  return { eventIds, cache: createRawEventIdCache(stat, eventIds) };
}

export function cacheRawEventIds(rawLogPath: string, eventIds: Set<string>): RawEventIdCache {
  return createRawEventIdCache(rawLogStat(rawLogPath), eventIds);
}

function createRawEventIdCache(stat: fs.Stats | undefined, eventIds: Set<string>): RawEventIdCache {
  return stat
    ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, eventIds }
    : { size: 0, mtimeMs: 0, ctimeMs: 0, eventIds };
}

export function emptyCleanupReport(indexPath: string): IndexCleanupReport {
  return {
    applied: false, raw_log_preserved: true, index_path: indexPath,
    database_bytes_before: 0, database_bytes_after: 0,
    event_fts_rows_before: 0, event_fts_rows_after: 0, projected_event_fts_rows: 0,
    event_text_bytes_before: 0, event_text_bytes_after: 0,
    projected_summaries_to_rebuild: 0, summaries_rebuilt: 0, vacuumed: false,
  };
}

export function inspectIndexForCleanup(db: DatabaseSync, indexPath: string): CleanupInspection {
  const searchableEvents = db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
    WHERE hook_event IN ${SUMMARY_SOURCE_HOOKS}
    ORDER BY timestamp ASC, rowid ASC
  `).all()
    .map((row) => decodePersistedEvent(String(recordValue(row).raw_json)))
    .filter(isSearchIndexEvent)
    .filter((event) => !isCodexLcmToolEvent(event));
  const summarySessionIds = new Set(searchableEvents.filter(isSummarySourceEvent).map((event) => event.session_id));
  return {
    databaseBytesBefore: fileSize(indexPath),
    eventFtsRowsBefore: scalar(db, "SELECT COUNT(*) AS count FROM event_fts"),
    eventTextBytesBefore: scalar(db, "SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS count FROM events"),
    searchableEvents,
    sessionIds: outdatedSummarySessionIds(db).filter((sessionId) => summarySessionIds.has(sessionId)),
  };
}

export function previewCleanupReport(indexPath: string, inspection: CleanupInspection): IndexCleanupReport {
  return {
    applied: false, raw_log_preserved: true, index_path: indexPath,
    database_bytes_before: inspection.databaseBytesBefore, database_bytes_after: inspection.databaseBytesBefore,
    event_fts_rows_before: inspection.eventFtsRowsBefore, event_fts_rows_after: inspection.eventFtsRowsBefore,
    projected_event_fts_rows: inspection.searchableEvents.length,
    event_text_bytes_before: inspection.eventTextBytesBefore, event_text_bytes_after: inspection.eventTextBytesBefore,
    projected_summaries_to_rebuild: inspection.sessionIds.length, summaries_rebuilt: 0, vacuumed: false,
  };
}

export function replaceCleanupSearchIndex(db: DatabaseSync, searchableEvents: readonly NormalizedEvent[]): void {
  db.prepare("DELETE FROM event_fts").run();
  const selectRowId = db.prepare("SELECT rowid FROM events WHERE event_id = ?1");
  const insertSearchEvent = db.prepare(`
    INSERT INTO event_fts (rowid, event_id, session_id, cwd, repo_root, hook_event, content)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
  `);
  for (const event of searchableEvents) {
    const rowId = Number(recordValue(selectRowId.get(event.event_id)).rowid);
    insertSearchEvent.run(rowId, event.event_id, event.session_id, event.cwd, event.repo_root ?? "", event.hook_event, eventSearchText(event));
  }
  db.prepare("UPDATE events SET text = '' WHERE text <> ''").run();
}

export function optimizeIndex(db: DatabaseSync): void {
  db.exec("INSERT INTO event_fts(event_fts) VALUES('optimize')");
  db.exec("INSERT INTO session_summary_fts(session_summary_fts) VALUES('optimize')");
  db.exec("INSERT INTO summary_node_fts(summary_node_fts) VALUES('optimize')");
  db.exec("PRAGMA optimize");
  db.exec("VACUUM");
}

export function appliedCleanupReport(db: DatabaseSync, indexPath: string, inspection: CleanupInspection): IndexCleanupReport {
  return {
    applied: true, raw_log_preserved: true, index_path: indexPath,
    database_bytes_before: inspection.databaseBytesBefore, database_bytes_after: fileSize(indexPath),
    event_fts_rows_before: inspection.eventFtsRowsBefore,
    event_fts_rows_after: scalar(db, "SELECT COUNT(*) AS count FROM event_fts"),
    projected_event_fts_rows: inspection.searchableEvents.length,
    event_text_bytes_before: inspection.eventTextBytesBefore,
    event_text_bytes_after: scalar(db, "SELECT COALESCE(SUM(length(CAST(text AS BLOB))), 0) AS count FROM events"),
    projected_summaries_to_rebuild: inspection.sessionIds.length,
    summaries_rebuilt: inspection.sessionIds.length, vacuumed: true,
  };
}

export function writableIndexHealth(
  db: DatabaseSync,
  config: LcmConfig,
  indexError: string | undefined,
  graphNodeCounts: Record<string, number>,
  graphEdgeCounts: Record<string, number>,
): Health {
  return {
    ...segmentStorageHealth(config),
    home: config.home, raw_log_path: config.rawLogPath, index_path: config.indexPath,
    raw_log_exists: fs.existsSync(config.rawLogPath), index_exists: fs.existsSync(config.indexPath),
    index_available: true, ...(indexError ? { index_error: indexError } : {}),
    event_count: scalar(db, "SELECT COUNT(*) AS count FROM events"),
    session_count: scalar(db, "SELECT COUNT(*) AS count FROM sessions"),
    graph_node_count: sumCounts(graphNodeCounts), graph_edge_count: sumCounts(graphEdgeCounts),
    summary_count: scalar(db, "SELECT COUNT(*) AS count FROM session_summaries"),
    summary_node_count: scalar(db, "SELECT COUNT(*) AS count FROM summary_nodes"),
  };
}

export function rawHealth(config: LcmConfig, indexError: string | undefined): Health {
  const rawEvents = readRawEvents(config.rawLogPath);
  return {
    ...segmentStorageHealth(config),
    home: config.home, raw_log_path: config.rawLogPath, index_path: config.indexPath,
    raw_log_exists: fs.existsSync(config.rawLogPath), index_exists: fs.existsSync(config.indexPath),
    index_available: false, ...(indexError ? { index_error: indexError } : {}),
    event_count: rawEvents.length, session_count: summarizeSessions(rawEvents).length,
  };
}

export function clearDerivedIndex(db: DatabaseSync): void {
  db.prepare("DELETE FROM summary_node_fts").run();
  db.prepare("DELETE FROM session_summary_fts").run();
  db.prepare("DELETE FROM event_fts").run();
  db.prepare("DELETE FROM summary_nodes").run();
  db.prepare("DELETE FROM session_summaries").run();
  db.prepare("DELETE FROM file_refs").run();
  db.prepare("DELETE FROM events").run();
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM index_metadata").run();
}

export function knownEventIds(db: DatabaseSync | undefined, rawLogPath: string, eventIds: readonly string[]): Set<string> {
  const uniqueIds = Array.from(new Set(eventIds.filter(Boolean)));
  if (uniqueIds.length === 0) return new Set();
  if (!db) {
    const wanted = new Set(uniqueIds);
    return new Set(readRawEvents(rawLogPath).map((event) => event.event_id).filter((eventId) => wanted.has(eventId)));
  }
  const known = new Set<string>();
  for (const chunk of chunkArray(uniqueIds, 500)) {
    const placeholders = chunk.map((_, index) => `?${index + 1}`).join(", ");
    for (const row of db.prepare(`SELECT event_id FROM events WHERE event_id IN (${placeholders})`).all(...chunk)) {
      known.add(String(recordValue(row).event_id));
    }
  }
  return known;
}

export function indexedEventsById(db: DatabaseSync): Map<string, string> {
  return new Map(db.prepare(`SELECT event_id, ${STORED_EVENT_JSON_SQL} AS raw_json FROM events`).all().map((row) => {
    const record = recordValue(row);
    return [String(record.event_id), String(record.raw_json)];
  }));
}

export function indexedRawLogState(db: DatabaseSync): string | undefined {
  const row = recordValue(db.prepare("SELECT value FROM index_metadata WHERE key = ?1").get(RAW_LOG_INDEX_STATE_KEY));
  return typeof row.value === "string" ? row.value : undefined;
}

export function indexedActiveLogIsAppendOnly(db: DatabaseSync, config: LcmConfig): boolean {
  const parsed = parsedIndexedRawLogState(db);
  const current = segmentedRawLogState(config);
  return parsed !== undefined && parsed.segmentState === current.segmentState && current.size > parsed.size;
}

function parsedIndexedRawLogState(db: DatabaseSync): { readonly size: number; readonly segmentState?: string } | undefined {
  const state = indexedRawLogState(db);
  if (!state) return undefined;
  try {
    const parsed = JSON.parse(state);
    if (typeof parsed !== "object" || parsed === null || typeof Reflect.get(parsed, "size") !== "number") return undefined;
    const segmentState = Reflect.get(parsed, "segmentState");
    return {
      size: Number(Reflect.get(parsed, "size")),
      ...(typeof segmentState === "string" ? { segmentState } : {}),
    };
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

export function isRawLogIndexed(db: DatabaseSync, config: LcmConfig): boolean {
  return indexedRawLogState(db) === JSON.stringify(segmentedRawLogState(config));
}

export function recordRawLogState(db: DatabaseSync, state: RawLogState): void {
  db.prepare(`
    INSERT INTO index_metadata (key, value) VALUES (?1, ?2)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(RAW_LOG_INDEX_STATE_KEY, JSON.stringify(state));
}

export function invalidateRawLogState(db: DatabaseSync): void {
  db.prepare("DELETE FROM index_metadata WHERE key = ?1").run(RAW_LOG_INDEX_STATE_KEY);
}

export function currentRawLogState(config: LcmConfig): RawLogState {
  return segmentedRawLogState(config);
}

export function initializeIndex(db: DatabaseSync): void {
  const { backfillSessionMetadata } = initializeStorageSchema(db);
  backfillExistingEventMetadata(db);
  if (backfillSessionMetadata) backfillExistingSessionMetadata(db);
  migrateSearchIndexes(db);
}

function migrateSearchIndexes(db: DatabaseSync): boolean {
  const names = ["event_fts", "session_summary_fts", "summary_node_fts"] as const;
  const schemas = db.prepare(`
    SELECT name, sql FROM sqlite_master
    WHERE type = 'table' AND name IN ('event_fts', 'session_summary_fts', 'summary_node_fts')
  `).all();
  if (names.every((name) => schemas.some((row) => {
    const record = recordValue(row);
    return record.name === name && String(record.sql).includes("contentless_delete=1");
  }))) return false;

  db.exec("BEGIN IMMEDIATE");
  try {
    const eventRows = db.prepare(`SELECT rowid, event_id, ${STORED_EVENT_JSON_SQL} AS raw_json FROM events ORDER BY rowid`).all();
    db.exec("DROP TABLE event_fts; DROP TABLE session_summary_fts; DROP TABLE summary_node_fts");
    createSearchIndexTables(db);
    const insertEvent = db.prepare(`
      INSERT INTO event_fts (rowid, event_id, session_id, cwd, repo_root, hook_event, content)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `);
    for (const row of eventRows) {
      const record = recordValue(row);
      const event = decodePersistedEvent(String(record.raw_json));
      if (event.event_id !== String(record.event_id)) {
        throw new Error(`Stored event locator mismatch for ${String(record.event_id)}.`);
      }
      if (!isSearchIndexEvent(event) || isCodexLcmToolEvent(event)) continue;
      insertEvent.run(
        Number(record.rowid), event.event_id, event.session_id, event.cwd,
        event.repo_root ?? "", event.hook_event, eventSearchText(event),
      );
    }
    const insertSummary = db.prepare(`
      INSERT INTO session_summary_fts (rowid, session_id, cwd, repo_root, content)
      VALUES (?1, ?2, ?3, ?4, ?5)
    `);
    for (const row of db.prepare("SELECT rowid, * FROM session_summaries ORDER BY rowid").all()) {
      const summary = rowToSessionMemorySummary(row);
      insertSummary.run(
        Number(recordValue(row).rowid), summary.session_id, summary.cwd,
        summary.repo_root ?? "", summarySearchText(summary),
      );
    }
    const insertNode = db.prepare(`
      INSERT INTO summary_node_fts (rowid, node_id, session_id, cwd, repo_root, depth, content)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `);
    for (const row of db.prepare("SELECT rowid, * FROM summary_nodes ORDER BY rowid").all()) {
      const node = rowToSummaryNode(row);
      insertNode.run(
        Number(recordValue(row).rowid), node.node_id, node.session_id, node.cwd,
        node.repo_root ?? "", String(node.depth), summaryNodeSearchText(node),
      );
    }
    db.prepare("INSERT OR REPLACE INTO index_metadata (key, value) VALUES (?1, 'pending')").run(SEARCH_INDEX_VACUUM_KEY);
    db.exec("COMMIT");
    return true;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

export function indexEventInTransaction(
  db: DatabaseSync | undefined,
  event: NormalizedEvent,
  rebuildSummary: boolean,
  location?: RawEventLocation,
): IndexEventResult {
  if (!db) return { inserted: false, summaryTouched: false };
  const metadata = extractEventMetadata(event);
  const sessionMetadata = extractSessionMetadata(event);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO events
      (event_id, session_id, timestamp, hook_event, cwd, repo_root, git_branch, turn_id, tool_use_id, text, raw_json,
       segment_id, raw_offset, raw_length, agent_id, overflow_sha256)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
  `).run(
    event.event_id, event.session_id, event.timestamp, event.hook_event, event.cwd,
    event.repo_root ?? null, event.git_branch ?? null, metadata.turn_id ?? null,
    metadata.tool_use_id ?? null, "", JSON.stringify(event), location?.segmentId ?? null,
    location?.offset ?? null, location?.length ?? null, eventAgentId(event) ?? null,
    overflowReferenceFromEvent(event)?.sha256 ?? null,
  );
  if (insert.changes === 0) return { inserted: false, summaryTouched: false };
  db.prepare(`
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
    event.session_id, event.timestamp, event.cwd, event.repo_root ?? null, event.git_branch ?? null,
    sessionMetadata.parent_session_id ?? null, sessionMetadata.agent_role ?? null,
    sessionMetadata.agent_nickname ?? null, sessionMetadata.model ?? null,
    sessionMetadata.reasoning_effort ?? null, sessionMetadata.total_input_tokens ?? null,
    sessionMetadata.cached_input_tokens ?? null, sessionMetadata.output_tokens ?? null,
    sessionMetadata.reasoning_output_tokens ?? null, sessionMetadata.total_tokens ?? null,
  );
  if (isSearchIndexEvent(event) && !isCodexLcmToolEvent(event)) {
    db.prepare(`
      INSERT INTO event_fts (rowid, event_id, session_id, cwd, repo_root, hook_event, content)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    `).run(insert.lastInsertRowid, event.event_id, event.session_id, event.cwd, event.repo_root ?? "", event.hook_event, eventSearchText(event));
  }
  indexFileRefsForEvent(db, event);
  const summaryTouched = isSummarySourceEvent(event);
  if (summaryTouched && rebuildSummary && shouldRebuildSessionMemorySummary(db, event)) rebuildSessionMemorySummary(db, event.session_id);
  return { inserted: true, summaryTouched };
}

export function clearVerifiedRawJson(db: DatabaseSync, segmentId: string, batchSize = 500): number {
  if (segmentId.length === 0 || !Number.isSafeInteger(batchSize) || batchSize <= 0) {
    throw new TypeError("Raw JSON clearing requires a segment ID and positive batch size.");
  }
  const markerKey = `raw_json_clear_v1:${segmentId}`;
  let cursor = Number(recordValue(db.prepare("SELECT value FROM index_metadata WHERE key = ?1").get(markerKey)).value ?? 0);
  let cleared = 0;
  for (;;) {
    const rows = db.prepare(`
      SELECT rowid, event_id, lcm_raw_json('', segment_id, raw_offset, raw_length) AS located_json
      FROM events
      WHERE segment_id = ?1 AND rowid > ?2 AND raw_json <> ''
      ORDER BY rowid ASC LIMIT ?3
    `).all(segmentId, cursor, batchSize);
    if (rows.length === 0) return cleared;
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const record = recordValue(row);
        const rowId = Number(record.rowid);
        const eventId = String(record.event_id);
        const event = decodePersistedEvent(String(record.located_json));
        if (event.event_id === eventId) {
          cleared += Number(db.prepare("UPDATE events SET raw_json = '' WHERE rowid = ?1 AND event_id = ?2").run(rowId, eventId).changes);
        }
        cursor = rowId;
      }
      db.prepare(`
        INSERT INTO index_metadata (key, value) VALUES (?1, ?2)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(markerKey, String(cursor));
      db.exec("COMMIT");
    } catch (error) {
      const rollback = rollbackPreservingError(db, error);
      if (rollback.kind === "rolled_back") throw error;
      throw new AggregateError([error, rollback.rollbackError], "Raw JSON clearing rollback failed.");
    }
  }
}

export function segmentsNeedRawJsonClearing(db: DatabaseSync, segmentIds: readonly string[]): boolean {
  const marker = db.prepare("SELECT 1 FROM index_metadata WHERE key = ?1");
  return segmentIds.some((segmentId) => marker.get(`raw_json_clear_v1:${segmentId}`) === undefined);
}

function eventAgentId(event: NormalizedEvent): string | undefined {
  const value = event.payload.agent_id ?? event.payload.agentId;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function indexFileRefsForEvent(db: DatabaseSync, event: NormalizedEvent): void {
  for (const ref of extractFileReferences(event)) {
    db.prepare(`
      INSERT INTO file_refs
        (file_ref_id, session_id, observed_event_id, timestamp, path, mime_type,
         byte_count, sha256, exploration_summary, metadata_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(file_ref_id) DO UPDATE SET
        session_id = excluded.session_id, observed_event_id = excluded.observed_event_id,
        timestamp = excluded.timestamp, path = excluded.path, mime_type = excluded.mime_type,
        byte_count = excluded.byte_count, sha256 = excluded.sha256,
        exploration_summary = excluded.exploration_summary, metadata_json = excluded.metadata_json
    `).run(
      ref.file_ref_id, ref.session_id, ref.observed_event_id, ref.timestamp, ref.path,
      ref.mime_type, ref.byte_count, ref.sha256, ref.exploration_summary, JSON.stringify(ref.metadata),
    );
  }
}

function backfillExistingEventMetadata(db: DatabaseSync): void {
  const marker = recordValue(db.prepare("SELECT value FROM index_metadata WHERE key = ?1").get(EVENT_METADATA_BACKFILL_KEY));
  if (marker.value === "1") return;
  const rows = db.prepare(`SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events`).all();
  const update = db.prepare(`
    UPDATE events SET turn_id = ?1, tool_use_id = ?2, agent_id = ?3, overflow_sha256 = ?4 WHERE event_id = ?5
  `);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const event = decodePersistedEvent(String(recordValue(row).raw_json));
      const metadata = extractEventMetadata(event);
      update.run(
        metadata.turn_id ?? null,
        metadata.tool_use_id ?? null,
        eventAgentId(event) ?? null,
        overflowReferenceFromEvent(event)?.sha256 ?? null,
        event.event_id,
      );
    }
    db.prepare(`
      INSERT INTO index_metadata (key, value) VALUES (?1, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(EVENT_METADATA_BACKFILL_KEY);
    db.prepare(`
      INSERT INTO index_metadata (key, value) VALUES (?1, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(EVENT_LOCATOR_METADATA_BACKFILL_KEY);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      throw error;
    }
    throw error;
  }
}

export function backfillLocatorMetadata(db: DatabaseSync): void {
  const marker = recordValue(db.prepare("SELECT value FROM index_metadata WHERE key = ?1").get(EVENT_LOCATOR_METADATA_BACKFILL_KEY));
  if (marker.value === "1") return;
  const rows = db.prepare(`SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events ORDER BY rowid ASC`).all();
  const update = db.prepare("UPDATE events SET agent_id = ?1, overflow_sha256 = ?2 WHERE event_id = ?3");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const event = decodePersistedEvent(String(recordValue(row).raw_json));
      update.run(eventAgentId(event) ?? null, overflowReferenceFromEvent(event)?.sha256 ?? null, event.event_id);
    }
    db.prepare(`
      INSERT INTO index_metadata (key, value) VALUES (?1, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(EVENT_LOCATOR_METADATA_BACKFILL_KEY);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function backfillExistingSessionMetadata(db: DatabaseSync): void {
  const rows = db.prepare(`SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events WHERE hook_event = 'SessionStart'`).all();
  const update = db.prepare("UPDATE sessions SET parent_session_id = ?2, agent_role = ?3, agent_nickname = ?4 WHERE session_id = ?1");
  for (const row of rows) {
    const event = decodePersistedEvent(String(recordValue(row).raw_json));
    const metadata = extractSessionMetadata(event);
    update.run(event.session_id, metadata.parent_session_id ?? null, metadata.agent_role ?? null, metadata.agent_nickname ?? null);
  }
}

export function backfillDelegationParents(db: DatabaseSync | undefined): string | undefined {
  if (!db) return undefined;
  const marker = recordValue(db.prepare("SELECT value FROM index_metadata WHERE key = ?1").get(DELEGATION_PARENT_BACKFILL_KEY));
  if (marker.value === "1") return undefined;
  const rows = db.prepare(`
    SELECT lcm_raw_json(e.raw_json, e.segment_id, e.raw_offset, e.raw_length) AS raw_json
    FROM events e JOIN sessions s ON s.session_id = e.session_id
    WHERE e.hook_event = 'UserPromptSubmit' AND s.parent_session_id IS NULL
    ORDER BY e.timestamp ASC, e.rowid ASC
  `).all();
  const update = db.prepare("UPDATE sessions SET parent_session_id = ?2 WHERE session_id = ?1 AND parent_session_id IS NULL");
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const event = decodePersistedEvent(String(recordValue(row).raw_json));
      const parentId = extractSessionMetadata(event).parent_session_id;
      if (parentId && parentId !== event.session_id) update.run(event.session_id, parentId);
    }
    db.prepare(`
      INSERT INTO index_metadata (key, value) VALUES (?1, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(DELEGATION_PARENT_BACKFILL_KEY);
    db.exec("COMMIT");
    return undefined;
  } catch (error) {
    const failure = rollbackPreservingError(db, error).original;
    return failure instanceof Error ? failure.message : String(failure);
  }
}

export function backfillFileRefs(db: DatabaseSync | undefined): string | undefined {
  if (!db) return undefined;
  const marker = recordValue(db.prepare("SELECT value FROM index_metadata WHERE key = ?1").get(FILE_REF_BACKFILL_KEY));
  if (marker.value === "1") return undefined;
  const rows = db.prepare(`
    SELECT ${STORED_EVENT_JSON_SQL} AS raw_json FROM events
    WHERE hook_event = 'PostToolUse' ORDER BY timestamp ASC, rowid ASC
  `).all();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) indexFileRefsForEvent(db, decodePersistedEvent(String(recordValue(row).raw_json)));
    db.prepare(`
      INSERT INTO index_metadata (key, value) VALUES (?1, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(FILE_REF_BACKFILL_KEY);
    db.exec("COMMIT");
    return undefined;
  } catch (error) {
    const failure = rollbackPreservingError(db, error).original;
    return failure instanceof Error ? failure.message : String(failure);
  }
}

export function backfillSessionMemorySummaries(db: DatabaseSync | undefined): string | undefined {
  if (!db) return undefined;
  const sessionIds = getSummaryBackfillSessionIds(db);
  if (sessionIds.length === 0) return undefined;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const sessionId of sessionIds) rebuildSessionMemorySummary(db, sessionId);
    db.exec("COMMIT");
    return undefined;
  } catch (error) {
    const failure = rollbackPreservingError(db, error).original;
    return failure instanceof Error ? failure.message : String(failure);
  }
}

function outdatedSummarySessionIds(db: DatabaseSync): string[] {
  return db.prepare(`
    SELECT s.session_id FROM sessions s
    LEFT JOIN session_summaries ss ON ss.session_id = s.session_id
    LEFT JOIN (
      SELECT session_id, MAX(summary_version) AS summary_node_version FROM summary_nodes GROUP BY session_id
    ) sn ON sn.session_id = s.session_id
    WHERE EXISTS (
      SELECT 1 FROM events e WHERE e.session_id = s.session_id AND e.hook_event IN ${SUMMARY_SOURCE_HOOKS}
    ) AND (
      ss.session_id IS NULL OR ss.summary_version IS NULL OR ss.summary_version < ${SUMMARY_ALGORITHM_VERSION}
      OR sn.summary_node_version IS NULL OR sn.summary_node_version < ${SUMMARY_NODE_VERSION}
    ) ORDER BY s.session_id ASC
  `).all().map((row) => String(recordValue(row).session_id));
}

function sumCounts(counts: Record<string, number>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

function fileSize(filePath: string): number {
  return fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
}

function chunkArray<T>(values: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size));
  return chunks;
}
