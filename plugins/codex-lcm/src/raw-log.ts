import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";

import { loadConfig, type LcmConfig } from "./config.ts";
import { parsePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";
import { readManifest, segmentStoreState, writeManifestAtomic, type SegmentRecord } from "./raw-segments.ts";

export type RawLogReadResult = {
  readonly events: NormalizedEvent[];
  readonly malformedLineCount: number;
};

export type RawLogState = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly segmentState?: string;
};

export type RawEventLocation = {
  readonly segmentId: string;
  readonly offset: number;
  readonly length: number;
};

export type LocatedRawEvent = {
  readonly event: NormalizedEvent;
  readonly location?: RawEventLocation;
};

export type SegmentedAppendOptions = {
  readonly segmentCapBytes?: number;
};

const RAW_LOG_LOCK_TIMEOUT_MS = 10_000;
const RAW_LOG_LOCK_POLL_MS = 10;
const DEFAULT_SEGMENT_CAP_BYTES = 64 * 1024 * 1024;
const RAW_READ_BUFFER_BYTES = 64 * 1024;
const RAW_LOG_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export class RawLogLockTimeoutError extends Error {
  readonly lockPath: string;

  constructor(lockPath: string) {
    super(`codex-lcm: raw log lock timeout: ${lockPath}`);
    this.name = "RawLogLockTimeoutError";
    this.lockPath = lockPath;
  }
}

export function withRawLogLock<T>(rawLogPath: string, callback: () => T): T {
  fs.mkdirSync(path.dirname(rawLogPath), { recursive: true, mode: 0o700 });
  const lockPath = `${rawLogPath}.lock.sqlite`;
  const deadline = Date.now() + RAW_LOG_LOCK_TIMEOUT_MS;
  const coordinator = new DatabaseSync(lockPath, { timeout: RAW_LOG_LOCK_POLL_MS });
  let transactionOpen = false;

  try {
    fs.chmodSync(lockPath, 0o600);
    while (!transactionOpen) {
      try {
        coordinator.exec("BEGIN IMMEDIATE");
        transactionOpen = true;
      } catch (error) {
        if (!isSqliteBusy(error)) throw error;
        waitForRawLogLock(deadline, lockPath);
      }
    }

    // ponytail: one writer lock is enough; shard only if raw-log contention becomes measurable.
    return callback();
  } finally {
    if (transactionOpen) coordinator.exec("ROLLBACK");
    coordinator.close();
  }
}

function waitForRawLogLock(deadline: number, lockPath: string): void {
  if (Date.now() >= deadline) {
    throw new RawLogLockTimeoutError(lockPath);
  }
  Atomics.wait(RAW_LOG_LOCK_WAIT, 0, 0, RAW_LOG_LOCK_POLL_MS);
}

function isSqliteBusy(error: unknown): boolean {
  return error instanceof Error && Reflect.get(error, "errcode") === 5;
}

export function appendRawEvents(rawLogPath: string, events: readonly NormalizedEvent[]): void {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(rawLogPath), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(rawLogPath);
  const previousSize = existed ? fs.statSync(rawLogPath).size : 0;
  const separator = rawLogNeedsSeparator(rawLogPath) ? "\n" : "";
  try {
    fs.appendFileSync(rawLogPath, `${separator}${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
    fsyncPath(rawLogPath, true);
    if (!existed && process.platform !== "win32") fsyncPath(path.dirname(rawLogPath));
  } catch (error) {
    try {
      restoreRawLog(rawLogPath, existed, previousSize);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Raw log append failed and rollback failed.");
    }
    throw error;
  }
}

export function appendSegmentedEvents(
  config: LcmConfig,
  events: readonly NormalizedEvent[],
  options: SegmentedAppendOptions = {},
): RawEventLocation[] {
  if (events.length === 0) return [];
  const segmentCapBytes = options.segmentCapBytes ?? DEFAULT_SEGMENT_CAP_BYTES;
  if (!Number.isSafeInteger(segmentCapBytes) || segmentCapBytes <= 0) {
    throw new Error("Segment cap must be a positive integer.");
  }

  const locations: RawEventLocation[] = [];
  for (const event of events) {
    const serialized = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    const activeSize = fs.existsSync(config.rawLogPath) ? fs.statSync(config.rawLogPath).size : 0;
    const separator = activeSize === 0 || !rawLogNeedsSeparator(config.rawLogPath) ? Buffer.alloc(0) : Buffer.from("\n");
    if (activeSize > 0 && activeSize + separator.length + serialized.length > segmentCapBytes) {
      rotateActiveRawLog(config);
    }
    locations.push(appendActiveEvent(config.rawLogPath, activeSegmentId(config), serialized));
  }
  return locations;
}

export function* readAllRawEvents(config: LcmConfig): Generator<NormalizedEvent> {
  for (const located of readAllLocatedRawEvents(config)) yield located.event;
}

export function* readAllLocatedRawEvents(config: LcmConfig): Generator<LocatedRawEvent> {
  const manifest = readManifest(config.manifestPath);
  if (manifest.migration?.complete === false) {
    for (const event of readRawFileEvents(relativeStorePath(config, manifest.migration.legacy_path))) yield { event };
    yield* readActiveRawEvents(config);
    return;
  }
  for (const record of manifest.segments) {
    yield* readSegmentLocatedEvents(config, record);
  }
  yield* readActiveRawEvents(config);
}

export function* readActiveRawEvents(config: LcmConfig): Generator<LocatedRawEvent> {
  yield* readRawFileLocatedEvents(config.rawLogPath, activeSegmentId(config));
}

export function readAllRawLog(config: LcmConfig): RawLogReadResult {
  const events: NormalizedEvent[] = [];
  let malformedLineCount = 0;
  const manifest = readManifest(config.manifestPath);
  if (manifest.migration?.complete === false) {
    const legacy = readRawLog(relativeStorePath(config, manifest.migration.legacy_path));
    const active = readRawLog(config.rawLogPath);
    return {
      events: [...legacy.events, ...active.events],
      malformedLineCount: legacy.malformedLineCount + active.malformedLineCount,
    };
  }
  for (const record of manifest.segments) {
    const result = readSegmentLog(config, record);
    events.push(...result.events);
    malformedLineCount += result.malformedLineCount;
  }
  const active = readRawLog(config.rawLogPath);
  events.push(...active.events);
  return { events, malformedLineCount: malformedLineCount + active.malformedLineCount };
}

export function readLocatedEvent(config: LcmConfig, location: RawEventLocation): NormalizedEvent {
  return createLocatedEventReader(config)(location);
}

export function createLocatedEventReader(config: LcmConfig): (location: RawEventLocation) => NormalizedEvent {
  let cachedSegmentId: string | undefined;
  let cachedContent: Buffer | undefined;
  return (location) => {
    const record = readManifest(config.manifestPath).segments.find((segment) => segment.id === location.segmentId);
    const targetPath = record
      ? segmentPath(config, record)
      : location.segmentId === activeSegmentId(config) ? config.rawLogPath : undefined;
    if (!targetPath) throw new Error(`Unknown raw segment: ${location.segmentId}`);
    if (!Number.isSafeInteger(location.offset) || location.offset < 0 || !Number.isSafeInteger(location.length) || location.length <= 0) {
      throw new Error("Invalid raw event location.");
    }
    if (record?.compressed) {
      if (cachedSegmentId !== record.id) {
        cachedContent = gunzipSync(fs.readFileSync(targetPath));
        cachedSegmentId = record.id;
      }
      const content = cachedContent;
      if (!content) throw new Error(`Compressed raw segment could not be read: ${record.id}`);
      const serialized = content.subarray(location.offset, location.offset + location.length);
      if (serialized.length !== location.length) throw new Error("Raw event location is outside the segment.");
      const event = parsePersistedEvent(serialized.toString("utf8").trim());
      if (!event) throw new Error("Raw event location does not contain a persisted event.");
      return event;
    }
    const descriptor = fs.openSync(targetPath, "r");
    try {
      const serialized = Buffer.allocUnsafe(location.length);
      const bytesRead = fs.readSync(descriptor, serialized, 0, serialized.length, location.offset);
      if (bytesRead !== serialized.length) throw new Error("Raw event location is outside the segment.");
      const event = parsePersistedEvent(serialized.toString("utf8").trim());
      if (!event) throw new Error("Raw event location does not contain a persisted event.");
      return event;
    } finally {
      fs.closeSync(descriptor);
    }
  };
}

function restoreRawLog(rawLogPath: string, existed: boolean, previousSize: number): void {
  if (existed) {
    fs.truncateSync(rawLogPath, previousSize);
    fsyncPath(rawLogPath, true);
    return;
  }
  if (fs.existsSync(rawLogPath)) fs.unlinkSync(rawLogPath);
  if (process.platform !== "win32") fsyncPath(path.dirname(rawLogPath));
}

function rawLogNeedsSeparator(rawLogPath: string): boolean {
  if (!fs.existsSync(rawLogPath)) return false;
  const size = fs.statSync(rawLogPath).size;
  if (size === 0) return false;
  const descriptor = fs.openSync(rawLogPath, "r");
  try {
    const lastByte = Buffer.allocUnsafe(1);
    return fs.readSync(descriptor, lastByte, 0, 1, size - 1) === 1 && lastByte[0] !== 0x0a;
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncPath(targetPath: string, writable = false): void {
  const descriptor = fs.openSync(targetPath, writable ? "r+" : "r");
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

export function readRawLog(rawLogPath: string): RawLogReadResult {
  if (!fs.existsSync(rawLogPath)) return { events: [], malformedLineCount: 0 };
  const events: NormalizedEvent[] = [];
  let malformedLineCount = 0;
  for (const line of readRawFileLines(rawLogPath)) {
    if (line.trim().length === 0) continue;
    const event = parsePersistedEvent(line);
    if (event) events.push(event);
    else malformedLineCount += 1;
  }
  return { events, malformedLineCount };
}

export function readRawEvents(rawLogPath: string): NormalizedEvent[] {
  const config = loadConfig({ home: path.dirname(rawLogPath) });
  if (rawLogPath === config.rawLogPath && fs.existsSync(config.manifestPath)) {
    return Array.from(readAllRawEvents(config));
  }
  return readRawLog(rawLogPath).events;
}

export function readRawEventIds(rawLogPath: string): Set<string> {
  return new Set(readRawEvents(rawLogPath).map((event) => event.event_id));
}

export function rawLogStat(rawLogPath: string): fs.Stats | undefined {
  return fs.existsSync(rawLogPath) ? fs.statSync(rawLogPath) : undefined;
}

export function rawLogState(rawLogPath: string): RawLogState {
  const stat = rawLogStat(rawLogPath);
  return stat
    ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
    : { size: 0, mtimeMs: 0, ctimeMs: 0 };
}

export function segmentedRawLogState(config: LcmConfig): RawLogState {
  return {
    ...rawLogState(config.rawLogPath),
    segmentState: segmentStoreState(readManifest(config.manifestPath)),
  };
}

function appendActiveEvent(rawLogPath: string, segmentId: string, serialized: Buffer): RawEventLocation {
  fs.mkdirSync(path.dirname(rawLogPath), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(rawLogPath);
  const previousSize = existed ? fs.statSync(rawLogPath).size : 0;
  const separator = previousSize === 0 || !rawLogNeedsSeparator(rawLogPath) ? Buffer.alloc(0) : Buffer.from("\n");
  try {
    fs.appendFileSync(rawLogPath, Buffer.concat([separator, serialized]), { mode: 0o600 });
    fsyncPath(rawLogPath, true);
    if (!existed && process.platform !== "win32") fsyncPath(path.dirname(rawLogPath));
  } catch (error) {
    try {
      restoreRawLog(rawLogPath, existed, previousSize);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], "Raw log append failed and rollback failed.");
    }
    throw error;
  }
  return { segmentId, offset: previousSize + separator.length, length: serialized.length };
}

function rotateActiveRawLog(config: LcmConfig): void {
  if (!fs.existsSync(config.rawLogPath) || fs.statSync(config.rawLogPath).size === 0) return;
  const manifest = readManifest(config.manifestPath);
  const id = nextSegmentId(manifest.segments);
  const relativePath = path.join("segments", `${id}.jsonl`);
  const destinationPath = path.join(config.home, relativePath);
  if (fs.existsSync(destinationPath)) throw new Error(`Raw segment already exists: ${id}`);
  const summary = summarizeRawFile(config.rawLogPath);
  fs.mkdirSync(config.segmentsDir, { recursive: true, mode: 0o700 });
  fsyncPath(config.rawLogPath, true);
  fs.renameSync(config.rawLogPath, destinationPath);
  try {
    writeManifestAtomic(config.manifestPath, {
      ...manifest,
      segments: [...manifest.segments, {
        id,
        path: relativePath,
        compressed: false,
        byte_count: summary.byteCount,
        event_count: summary.eventCount,
        first_timestamp: summary.firstTimestamp,
        last_timestamp: summary.lastTimestamp,
        sha256: summary.sha256,
      }],
    });
    if (process.platform !== "win32") fsyncPath(config.home);
  } catch (error) {
    fs.renameSync(destinationPath, config.rawLogPath);
    throw error;
  }
}

function nextSegmentId(segments: readonly SegmentRecord[]): string {
  const lastNumericId = segments.reduce((maximum, segment) => {
    const value = /^[0-9]+$/u.test(segment.id) ? Number(segment.id) : 0;
    return Number.isSafeInteger(value) ? Math.max(maximum, value) : maximum;
  }, 0);
  return String(lastNumericId + 1).padStart(16, "0");
}

function activeSegmentId(config: LcmConfig): string {
  return nextSegmentId(readManifest(config.manifestPath).segments);
}

function segmentPath(config: LcmConfig, record: SegmentRecord): string {
  const targetPath = path.resolve(config.home, record.path);
  const relative = path.relative(config.home, targetPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Segment path escapes the LCM home: ${record.id}`);
  }
  return targetPath;
}

function* readSegmentLocatedEvents(config: LcmConfig, record: SegmentRecord): Generator<LocatedRawEvent> {
  if (!record.compressed) {
    yield* readRawFileLocatedEvents(segmentPath(config, record), record.id);
    return;
  }
  yield* readRawBufferLocatedEvents(gunzipSync(fs.readFileSync(segmentPath(config, record))), record.id);
}

function readSegmentLog(config: LcmConfig, record: SegmentRecord): RawLogReadResult {
  return record.compressed
    ? parseRawBuffer(gunzipSync(fs.readFileSync(segmentPath(config, record))))
    : readRawLog(segmentPath(config, record));
}

function parseRawBuffer(content: Buffer): RawLogReadResult {
  const events: NormalizedEvent[] = [];
  let malformedLineCount = 0;
  for (const line of content.toString("utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const event = parsePersistedEvent(line);
    if (event) events.push(event);
    else malformedLineCount += 1;
  }
  return { events, malformedLineCount };
}

function relativeStorePath(config: LcmConfig, relativePath: string): string {
  const targetPath = path.resolve(config.home, relativePath);
  const relative = path.relative(config.home, targetPath);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Raw store path escapes the LCM home.");
  }
  return targetPath;
}

function summarizeRawFile(rawLogPath: string): {
  readonly byteCount: number;
  readonly eventCount: number;
  readonly firstTimestamp: string;
  readonly lastTimestamp: string;
  readonly sha256: string;
} {
  const stat = fs.statSync(rawLogPath);
  const events = readRawLog(rawLogPath).events;
  const first = events[0];
  const last = events.at(-1);
  return {
    byteCount: stat.size,
    eventCount: events.length,
    firstTimestamp: first?.timestamp ?? "1970-01-01T00:00:00.000Z",
    lastTimestamp: last?.timestamp ?? "1970-01-01T00:00:00.000Z",
    sha256: hashRawFile(rawLogPath),
  };
}

function hashRawFile(rawLogPath: string): string {
  const descriptor = fs.openSync(rawLogPath, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(RAW_READ_BUFFER_BYTES);
  try {
    for (let offset = 0; ; offset += RAW_READ_BUFFER_BYTES) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return hash.digest("hex");
}

function* readRawFileEvents(rawLogPath: string): Generator<NormalizedEvent> {
  if (!fs.existsSync(rawLogPath)) return;
  for (const line of readRawFileLines(rawLogPath)) {
    if (line.trim().length === 0) continue;
    const event = parsePersistedEvent(line);
    if (event) yield event;
  }
}

function* readRawFileLocatedEvents(rawLogPath: string, segmentId: string): Generator<LocatedRawEvent> {
  if (!fs.existsSync(rawLogPath)) return;
  for (const record of readRawFileLineRecords(rawLogPath)) {
    if (record.line.trim().length === 0) continue;
    const event = parsePersistedEvent(record.line);
    if (event) {
      yield { event, location: { segmentId, offset: record.offset, length: record.length } };
    }
  }
}

function* readRawBufferLocatedEvents(content: Buffer, segmentId: string): Generator<LocatedRawEvent> {
  let lineStart = 0;
  for (let index = 0; index <= content.length; index += 1) {
    if (index < content.length && content[index] !== 0x0a) continue;
    const length = index - lineStart + (index < content.length ? 1 : 0);
    const line = content.subarray(lineStart, index).toString("utf8").replace(/\r$/u, "");
    if (line.trim().length > 0) {
      const event = parsePersistedEvent(line);
      if (event) yield { event, location: { segmentId, offset: lineStart, length } };
    }
    lineStart = index + 1;
  }
}

function* readRawFileLines(rawLogPath: string): Generator<string> {
  for (const record of readRawFileLineRecords(rawLogPath)) yield record.line;
}

function* readRawFileLineRecords(
  rawLogPath: string,
): Generator<{ readonly line: string; readonly offset: number; readonly length: number }> {
  const descriptor = fs.openSync(rawLogPath, "r");
  const buffer = Buffer.allocUnsafe(RAW_READ_BUFFER_BYTES);
  let remainder = Buffer.alloc(0);
  let remainderOffset = 0;
  try {
    for (let offset = 0; ; offset += RAW_READ_BUFFER_BYTES) {
      const bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, offset);
      if (bytesRead === 0) break;
      const input = remainder.length === 0
        ? Buffer.from(buffer.subarray(0, bytesRead))
        : Buffer.concat([remainder, buffer.subarray(0, bytesRead)]);
      let lineStart = 0;
      for (let index = 0; index < input.length; index += 1) {
        if (input[index] !== 0x0a) continue;
        const line = input.subarray(lineStart, index);
        yield {
          line: line.toString("utf8").replace(/\r$/u, ""),
          offset: remainderOffset + lineStart,
          length: index - lineStart + 1,
        };
        lineStart = index + 1;
      }
      remainder = Buffer.from(input.subarray(lineStart));
      remainderOffset += lineStart;
    }
    if (remainder.length > 0) {
      yield {
        line: remainder.toString("utf8").replace(/\r$/u, ""),
        offset: remainderOffset,
        length: remainder.length,
      };
    }
  } finally {
    fs.closeSync(descriptor);
  }
}
