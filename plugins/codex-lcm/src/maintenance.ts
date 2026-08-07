import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync, gzipSync } from "node:zlib";

import type { LcmConfig } from "./config.ts";
import { parsePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";
import { segmentedRawLogState, withRawLogLock } from "./raw-log.ts";
import { emptySegmentManifest, readManifest, writeManifestAtomic, type SegmentRecord } from "./raw-segments.ts";
import {
  backfillLocatorMetadata,
  clearVerifiedRawJson,
  indexEventInTransaction,
  invalidateRawLogState,
  recordRawLogState,
  segmentsNeedRawJsonClearing,
} from "./storage-persistence.ts";
import { registerStoredEventReader } from "./stored-event.ts";

const LEGACY_RELATIVE_PATH = "segments/legacy.jsonl";
const DEFAULT_SEGMENT_CAP_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;
const MAINTENANCE_MARKER = "CODEX_LCM_MAINTENANCE_WORKER";

export type MaintenanceReport = {
  readonly migrated: number;
  readonly compressed: number;
  readonly expired: number;
  readonly cleared: number;
  readonly quarantined: number;
  readonly errors: readonly string[];
};

export type MaintenanceOptions = {
  readonly maxSegments?: number;
  readonly segmentCapBytes?: number;
  readonly now?: () => Date;
};

type MigratedEvent = {
  readonly event: NormalizedEvent;
  readonly serialized: Buffer;
  readonly offset: number;
};

type QuarantineRecord = {
  readonly offset: number;
  readonly length: number;
  readonly sha256: string;
};

type MigrationBatch = {
  readonly events: readonly MigratedEvent[];
  readonly quarantines: readonly QuarantineRecord[];
  readonly nextOffset: number;
  readonly eof: boolean;
};

export function cutOverLegacyLog(config: LcmConfig): boolean {
  return withRawLogLock(config.rawLogPath, () => {
    if (fs.existsSync(config.manifestPath)) return false;
    const legacyPath = path.join(config.home, LEGACY_RELATIVE_PATH);
    if (fs.existsSync(legacyPath)) {
      if (fs.existsSync(config.rawLogPath) && fs.statSync(config.rawLogPath).size > 0) {
        throw new Error("Cannot recover legacy migration while the active raw log contains events.");
      }
      if (!fs.existsSync(config.rawLogPath)) fs.writeFileSync(config.rawLogPath, "", { mode: 0o600, flag: "wx" });
      writeManifestAtomic(config.manifestPath, {
        version: 1,
        migration: { legacy_path: LEGACY_RELATIVE_PATH, offset: 0, complete: false },
        segments: [],
      });
      return true;
    }
    if (!fs.existsSync(config.rawLogPath) || fs.statSync(config.rawLogPath).size === 0) {
      writeManifestAtomic(config.manifestPath, emptySegmentManifest());
      return false;
    }

    fs.mkdirSync(config.segmentsDir, { recursive: true, mode: 0o700 });
    fs.renameSync(config.rawLogPath, legacyPath);
    fsyncDirectory(config.segmentsDir);
    fsyncDirectory(config.home);
    try {
      fs.writeFileSync(config.rawLogPath, "", { mode: 0o600, flag: "wx" });
      writeManifestAtomic(config.manifestPath, {
        version: 1,
        migration: { legacy_path: LEGACY_RELATIVE_PATH, offset: 0, complete: false },
        segments: [],
      });
      return true;
    } catch (error) {
      if (fs.existsSync(config.rawLogPath) && fs.statSync(config.rawLogPath).size === 0) fs.unlinkSync(config.rawLogPath);
      fs.renameSync(legacyPath, config.rawLogPath);
      throw error;
    }
  });
}

export function migrationInProgress(config: LcmConfig): boolean {
  if (!fs.existsSync(config.manifestPath)) return false;
  return readManifest(config.manifestPath).migration?.complete === false;
}

export function runMaintenanceOnce(config: LcmConfig, options: MaintenanceOptions = {}): MaintenanceReport {
  const empty = { migrated: 0, compressed: 0, expired: 0, cleared: 0, quarantined: 0, errors: [] } satisfies MaintenanceReport;
  if (!fs.existsSync(config.manifestPath)) return empty;
  fs.mkdirSync(config.home, { recursive: true, mode: 0o700 });
  const coordinator = new DatabaseSync(config.maintenancePath, { timeout: 0 });
  let locked = false;
  try {
    fs.chmodSync(config.maintenancePath, 0o600);
    try {
      coordinator.exec("BEGIN IMMEDIATE");
      locked = true;
    } catch (error) {
      if (error instanceof Error && Reflect.get(error, "errcode") === 5) return empty;
      throw error;
    }
    const migration = migrateLegacy(config, options);
    if (migrationInProgress(config) || migration.errors.length > 0) return migration;
    const segments = maintainSegments(config, options.now ?? (() => new Date()));
    return {
      migrated: migration.migrated,
      compressed: segments.compressed,
      expired: segments.expired,
      cleared: segments.cleared,
      quarantined: migration.quarantined,
      errors: segments.errors,
    };
  } finally {
    if (locked) coordinator.exec("ROLLBACK");
    coordinator.close();
  }
}

export function queueMaintenance(config: LcmConfig): void {
  if (process.env[MAINTENANCE_MARKER] === "1" || !maintenanceNeeded(config)) return;
  const entry = process.argv[1];
  if (!entry) return;
  const child = spawn(process.execPath, ["--no-warnings", entry, "maintain", "--once"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, CODEX_LCM_HOME: config.home, [MAINTENANCE_MARKER]: "1" },
  });
  child.unref();
}

function maintenanceNeeded(config: LcmConfig): boolean {
  if (!fs.existsSync(config.manifestPath)) return false;
  const manifest = readManifest(config.manifestPath);
  return manifest.migration?.complete === false
    || manifest.segments.some((record) => !record.compressed)
    || archivedPayloadClearingNeeded(config, manifest.segments.map((record) => record.id))
    || (config.retentionDays !== undefined && config.configError === undefined);
}

function archivedPayloadClearingNeeded(config: LcmConfig, segmentIds: readonly string[]): boolean {
  if (segmentIds.length === 0 || !fs.existsSync(config.indexPath)) return false;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(config.indexPath, { readOnly: true });
    return segmentsNeedRawJsonClearing(db, segmentIds);
  } catch (error) {
    if (error instanceof Error) return true;
    throw error;
  } finally {
    db?.close();
  }
}

function migrateLegacy(config: LcmConfig, options: MaintenanceOptions): MaintenanceReport {
  const initial = readManifest(config.manifestPath);
  const migration = initial.migration;
  if (!migration || migration.complete) {
    return { migrated: 0, compressed: 0, expired: 0, cleared: 0, quarantined: 0, errors: [] };
  }
  const legacyPath = path.join(config.home, migration.legacy_path);
  if (!fs.existsSync(legacyPath)) {
    return { migrated: 0, compressed: 0, expired: 0, cleared: 0, quarantined: 0, errors: ["Legacy migration source is missing."] };
  }
  const segmentCapBytes = options.segmentCapBytes ?? DEFAULT_SEGMENT_CAP_BYTES;
  if (!Number.isSafeInteger(segmentCapBytes) || segmentCapBytes <= 0) throw new TypeError("Segment cap must be a positive integer.");
  const maxSegments = options.maxSegments ?? Number.POSITIVE_INFINITY;
  if (!(maxSegments === Number.POSITIVE_INFINITY || (Number.isSafeInteger(maxSegments) && maxSegments > 0))) {
    throw new TypeError("Maximum segment count must be a positive integer.");
  }

  const db = fs.existsSync(config.indexPath) ? new DatabaseSync(config.indexPath, { timeout: 5_000 }) : undefined;
  if (db) {
    registerStoredEventReader(db, config);
    backfillLocatorMetadata(db);
  }
  let migrated = 0;
  let quarantined = quarantineCount(config);
  let segmentsWritten = 0;
  try {
    for (;;) {
      const current = readManifest(config.manifestPath);
      const state = current.migration;
      if (!state || state.complete || segmentsWritten >= maxSegments) break;
      const batch = readMigrationBatch(legacyPath, state.offset, segmentCapBytes, db);
      for (const record of batch.quarantines) writeQuarantine(config, record);
      quarantined = quarantineCount(config);
      if (batch.events.length > 0) {
        const record = publishLegacySegment(config, current.segments, batch.events, batch.nextOffset, db);
        migrated += record.event_count;
        segmentsWritten += 1;
      } else {
        updateMigrationOffset(config, batch.nextOffset);
      }
      if (!batch.eof) continue;
      const missingLocators = db
        ? Number(db.prepare("SELECT COUNT(*) AS count FROM events WHERE segment_id IS NULL").get()?.count ?? 0)
        : 0;
      const errors = [
        ...(quarantined > 0 ? [`${quarantined} malformed legacy records were quarantined.`] : []),
        ...(missingLocators > 0 ? [`${missingLocators} indexed events have no raw locator.`] : []),
      ];
      finishMigration(config, batch.nextOffset, errors[0]);
      if (errors.length === 0) fs.unlinkSync(legacyPath);
      return { migrated, compressed: 0, expired: 0, cleared: 0, quarantined, errors };
    }
  } finally {
    db?.close();
  }
  return { migrated, compressed: 0, expired: 0, cleared: 0, quarantined, errors: [] };
}

function maintainSegments(config: LcmConfig, now: () => Date): MaintenanceReport {
  let cleared = 0;
  let compressed = 0;
  const errors: string[] = [];
  const db = fs.existsSync(config.indexPath) ? new DatabaseSync(config.indexPath, { timeout: 5_000 }) : undefined;
  if (db) {
    registerStoredEventReader(db, config);
    backfillLocatorMetadata(db);
  }
  try {
    for (const record of readManifest(config.manifestPath).segments) {
      if (db) cleared += clearVerifiedRawJson(db, record.id);
      if (record.compressed) continue;
      try {
        compressSegment(config, record);
        compressed += 1;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    const retention = expireSegments(config, db, now());
    errors.push(...retention.errors);
    if (db && (cleared > 0 || retention.expired > 0)) {
      db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
    }
    if (db && errors.length === 0) {
      const state = withRawLogLock(config.rawLogPath, () => segmentedRawLogState(config));
      recordRawLogState(db, state);
    }
    return { migrated: 0, compressed, expired: retention.expired, cleared, quarantined: 0, errors };
  } finally {
    db?.close();
  }
}

function expireSegments(
  config: LcmConfig,
  db: DatabaseSync | undefined,
  now: Date,
): { readonly expired: number; readonly errors: readonly string[] } {
  if (config.configError) return { expired: 0, errors: [config.configError] };
  if (config.retentionDays === undefined) return { expired: 0, errors: [] };
  const cutoff = new Date(now.getTime() - config.retentionDays * 24 * 60 * 60 * 1_000).toISOString();
  const manifest = readManifest(config.manifestPath);
  const expired = manifest.segments.filter((record) => record.last_timestamp < cutoff);
  if (expired.length === 0) return { expired: 0, errors: [] };
  if (db) {
    db.exec("BEGIN IMMEDIATE");
    try {
      invalidateRawLogState(db);
      for (const record of expired) {
        db.prepare("DELETE FROM event_fts WHERE event_id IN (SELECT event_id FROM events WHERE segment_id = ?1)").run(record.id);
        db.prepare("DELETE FROM file_refs WHERE observed_event_id IN (SELECT event_id FROM events WHERE segment_id = ?1)").run(record.id);
        db.prepare("DELETE FROM events WHERE segment_id = ?1").run(record.id);
      }
      db.prepare(`
        UPDATE sessions SET event_count = (SELECT COUNT(*) FROM events WHERE events.session_id = sessions.session_id)
      `).run();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  const expiredIds = new Set(expired.map((record) => record.id));
  withRawLogLock(config.rawLogPath, () => {
    const current = readManifest(config.manifestPath);
    writeManifestAtomic(config.manifestPath, {
      ...current,
      segments: current.segments.filter((record) => !expiredIds.has(record.id)),
    });
  });
  for (const record of expired) {
    const targetPath = path.join(config.home, record.path);
    if (fs.existsSync(targetPath)) fs.unlinkSync(targetPath);
  }
  if (db) removeOrphanOverflow(config, db);
  return { expired: expired.length, errors: [] };
}

function removeOrphanOverflow(config: LcmConfig, db: DatabaseSync): void {
  if (!fs.existsSync(config.overflowDir)) return;
  const live = new Set(db.prepare("SELECT DISTINCT overflow_sha256 FROM events WHERE overflow_sha256 IS NOT NULL").all()
    .map((row) => row.overflow_sha256)
    .filter((value): value is string => typeof value === "string"));
  for (const name of fs.readdirSync(config.overflowDir)) {
    const match = /^([a-f0-9]{64})\.json$/u.exec(name);
    if (!match || live.has(match[1])) continue;
    const targetPath = path.join(config.overflowDir, name);
    if (fs.lstatSync(targetPath).isFile()) fs.unlinkSync(targetPath);
  }
}

function compressSegment(config: LcmConfig, record: SegmentRecord): void {
  const plainPath = path.join(config.home, record.path);
  const plain = fs.readFileSync(plainPath);
  verifySegmentContent(plain, record);
  const compressed = gzipSync(plain, { level: 1 });
  verifySegmentContent(gunzipSync(compressed), record);
  const relativePath = `${record.path}.gz`;
  const compressedPath = path.join(config.home, relativePath);
  const temporaryPath = `${compressedPath}.tmp`;
  const descriptor = fs.openSync(temporaryPath, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, compressed);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, compressedPath);
  withRawLogLock(config.rawLogPath, () => {
    const manifest = readManifest(config.manifestPath);
    writeManifestAtomic(config.manifestPath, {
      ...manifest,
      segments: manifest.segments.map((current) => current.id === record.id
        ? { ...current, path: relativePath, compressed: true }
        : current),
    });
  });
  fs.unlinkSync(plainPath);
}

function verifySegmentContent(content: Buffer, record: SegmentRecord): void {
  if (hashBuffer(content) !== record.sha256) throw new Error(`Segment checksum failed: ${record.id}`);
  const events = content.toString("utf8").split(/\r?\n/u).filter((line) => line.length > 0);
  if (events.length !== record.event_count || events.some((line) => parsePersistedEvent(line) === undefined)) {
    throw new Error(`Segment event count failed: ${record.id}`);
  }
}

function readMigrationBatch(
  legacyPath: string,
  startOffset: number,
  segmentCapBytes: number,
  db: DatabaseSync | undefined,
): MigrationBatch {
  const descriptor = fs.openSync(legacyPath, "r");
  const readBuffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  const events: MigratedEvent[] = [];
  const quarantines: QuarantineRecord[] = [];
  let canonicalBytes = 0;
  let readPosition = startOffset;
  let pending = Buffer.alloc(0);
  let pendingOffset = startOffset;
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, readBuffer, 0, readBuffer.length, readPosition);
      if (bytesRead === 0) {
        if (pending.length > 0) {
          const result = addLegacyLine(pending, pendingOffset, events, quarantines, canonicalBytes, segmentCapBytes, db);
          if (!result.added) return { events, quarantines, nextOffset: pendingOffset, eof: false };
          canonicalBytes = result.canonicalBytes;
          readPosition = pendingOffset + pending.length;
        }
        return { events, quarantines, nextOffset: readPosition, eof: true };
      }
      const input = pending.length === 0
        ? Buffer.from(readBuffer.subarray(0, bytesRead))
        : Buffer.concat([pending, readBuffer.subarray(0, bytesRead)]);
      const inputOffset = pendingOffset;
      readPosition += bytesRead;
      let lineStart = 0;
      for (let index = 0; index < input.length; index += 1) {
        if (input[index] !== 0x0a) continue;
        const lineOffset = inputOffset + lineStart;
        const line = input.subarray(lineStart, index);
        const result = addLegacyLine(line, lineOffset, events, quarantines, canonicalBytes, segmentCapBytes, db, 1);
        if (!result.added) return { events, quarantines, nextOffset: lineOffset, eof: false };
        canonicalBytes = result.canonicalBytes;
        lineStart = index + 1;
        if (canonicalBytes >= segmentCapBytes || inputOffset + lineStart - startOffset >= segmentCapBytes) {
          return { events, quarantines, nextOffset: inputOffset + lineStart, eof: inputOffset + lineStart === fs.fstatSync(descriptor).size };
        }
      }
      pending = Buffer.from(input.subarray(lineStart));
      pendingOffset = inputOffset + lineStart;
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function addLegacyLine(
  line: Buffer,
  offset: number,
  events: MigratedEvent[],
  quarantines: QuarantineRecord[],
  canonicalBytes: number,
  segmentCapBytes: number,
  db: DatabaseSync | undefined,
  newlineBytes = 0,
): { readonly added: boolean; readonly canonicalBytes: number } {
  if (line.length === 0) return { added: true, canonicalBytes };
  const event = parsePersistedEvent(line.toString("utf8")) ?? repairMalformedEvent(line, db);
  if (!event) {
    quarantines.push({ offset, length: line.length + newlineBytes, sha256: hashBuffer(line) });
    return { added: true, canonicalBytes };
  }
  const serialized = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
  if (events.length > 0 && canonicalBytes + serialized.length > segmentCapBytes) {
    return { added: false, canonicalBytes };
  }
  events.push({ event, serialized, offset: canonicalBytes });
  return { added: true, canonicalBytes: canonicalBytes + serialized.length };
}

function repairMalformedEvent(line: Buffer, db: DatabaseSync | undefined): NormalizedEvent | undefined {
  if (!db) return undefined;
  const match = /"event_id"\s*:\s*"([a-f0-9]{64})"/u.exec(line.subarray(0, 4_096).toString("utf8"));
  const eventId = match?.[1];
  if (!eventId) return undefined;
  const rawJson = db.prepare("SELECT raw_json FROM events WHERE event_id = ?1 AND raw_json <> ''").get(eventId)?.raw_json;
  if (typeof rawJson !== "string") return undefined;
  const event = parsePersistedEvent(rawJson);
  return event?.event_id === eventId ? event : undefined;
}

function publishLegacySegment(
  config: LcmConfig,
  existingSegments: readonly SegmentRecord[],
  events: readonly MigratedEvent[],
  nextOffset: number,
  db: DatabaseSync | undefined,
): SegmentRecord {
  const sequence = existingSegments.filter((segment) => segment.id.startsWith("legacy-")).length + 1;
  const id = `legacy-${String(sequence).padStart(16, "0")}`;
  const relativePath = `segments/${id}.jsonl`;
  const segmentPath = path.join(config.home, relativePath);
  const content = Buffer.concat(events.map((entry) => entry.serialized));
  const record: SegmentRecord = {
    id,
    path: relativePath,
    compressed: false,
    byte_count: content.length,
    event_count: events.length,
    first_timestamp: events[0]?.event.timestamp ?? "1970-01-01T00:00:00.000Z",
    last_timestamp: events.at(-1)?.event.timestamp ?? "1970-01-01T00:00:00.000Z",
    sha256: hashBuffer(content),
  };
  writeSegmentFile(segmentPath, content, record.sha256);
  if (db) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const update = db.prepare(`
        UPDATE events SET segment_id = ?1, raw_offset = ?2, raw_length = ?3 WHERE event_id = ?4
      `);
      for (const entry of events) {
        const location = { segmentId: id, offset: entry.offset, length: entry.serialized.length };
        const indexed = indexEventInTransaction(db, entry.event, false, location);
        if (!indexed.inserted) update.run(id, entry.offset, entry.serialized.length, entry.event.event_id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  withRawLogLock(config.rawLogPath, () => {
    const manifest = readManifest(config.manifestPath);
    const legacySegments = manifest.segments.filter((segment) => segment.id.startsWith("legacy-"));
    const laterSegments = manifest.segments.filter((segment) => !segment.id.startsWith("legacy-"));
    writeManifestAtomic(config.manifestPath, {
      ...manifest,
      migration: { legacy_path: manifest.migration?.legacy_path ?? LEGACY_RELATIVE_PATH, offset: nextOffset, complete: false },
      segments: [...legacySegments, record, ...laterSegments],
    });
  });
  return record;
}

function writeSegmentFile(segmentPath: string, content: Buffer, expectedHash: string): void {
  if (fs.existsSync(segmentPath)) {
    if (hashFile(segmentPath) !== expectedHash) throw new Error(`Existing migration segment failed verification: ${segmentPath}`);
    return;
  }
  const temporaryPath = `${segmentPath}.tmp`;
  const descriptor = fs.openSync(temporaryPath, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, content);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, segmentPath);
}

function updateMigrationOffset(config: LcmConfig, offset: number): void {
  withRawLogLock(config.rawLogPath, () => {
    const manifest = readManifest(config.manifestPath);
    writeManifestAtomic(config.manifestPath, {
      ...manifest,
      migration: { legacy_path: manifest.migration?.legacy_path ?? LEGACY_RELATIVE_PATH, offset, complete: false },
    });
  });
}

function finishMigration(config: LcmConfig, offset: number, error: string | undefined): void {
  withRawLogLock(config.rawLogPath, () => {
    const manifest = readManifest(config.manifestPath);
    writeManifestAtomic(config.manifestPath, {
      ...manifest,
      migration: {
        legacy_path: manifest.migration?.legacy_path ?? LEGACY_RELATIVE_PATH,
        offset,
        complete: true,
        ...(error ? { error } : {}),
      },
    });
  });
}

function writeQuarantine(config: LcmConfig, record: QuarantineRecord): void {
  const quarantineDir = path.join(config.segmentsDir, "quarantine");
  fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
  const targetPath = path.join(quarantineDir, `${String(record.offset).padStart(20, "0")}.json`);
  if (!fs.existsSync(targetPath)) fs.writeFileSync(targetPath, JSON.stringify(record), { mode: 0o600, flag: "wx" });
}

function quarantineCount(config: LcmConfig): number {
  const quarantineDir = path.join(config.segmentsDir, "quarantine");
  if (!fs.existsSync(quarantineDir)) return 0;
  return fs.readdirSync(quarantineDir).filter((name) => /^[0-9]{20}\.json$/u.test(name)).length;
}

function hashBuffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashFile(filePath: string): string {
  const descriptor = fs.openSync(filePath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
  try {
    for (;;) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
