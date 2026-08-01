import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { parsePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";

export type RawLogReadResult = {
  readonly events: NormalizedEvent[];
  readonly malformedLineCount: number;
};

export type RawLogState = {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
};

const RAW_LOG_LOCK_TIMEOUT_MS = 10_000;
const RAW_LOG_LOCK_POLL_MS = 10;
const RAW_LOG_LOCK_WAIT = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export function withRawLogLock<T>(rawLogPath: string, callback: () => T): T {
  fs.mkdirSync(path.dirname(rawLogPath), { recursive: true, mode: 0o700 });
  const lockPath = `${rawLogPath}.lock`;
  const token = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + RAW_LOG_LOCK_TIMEOUT_MS;
  let descriptor: number;

  while (true) {
    try {
      descriptor = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (clearStaleRawLogLock(lockPath)) continue;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for raw log lock: ${lockPath}`);
      Atomics.wait(RAW_LOG_LOCK_WAIT, 0, 0, RAW_LOG_LOCK_POLL_MS);
      continue;
    }
    try {
      fs.writeFileSync(descriptor, token);
      break;
    } catch (error) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the lock setup failure.
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        // A later writer can clear a stale lock if cleanup also failed.
      }
      throw error;
    }
  }

  // ponytail: one writer lock is enough; shard only if raw-log contention becomes measurable.
  try {
    return callback();
  } finally {
    fs.closeSync(descriptor);
    try {
      if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export function appendRawEvents(rawLogPath: string, events: readonly NormalizedEvent[]): void {
  if (events.length === 0) return;
  fs.mkdirSync(path.dirname(rawLogPath), { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(rawLogPath);
  const separator = rawLogNeedsSeparator(rawLogPath) ? "\n" : "";
  fs.appendFileSync(rawLogPath, `${separator}${events.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
  fsyncPath(rawLogPath);
  if (!existed && process.platform !== "win32") fsyncPath(path.dirname(rawLogPath));
}

function clearStaleRawLogLock(lockPath: string): boolean {
  try {
    const [ownerText] = fs.readFileSync(lockPath, "utf8").split(":", 1);
    const owner = Number(ownerText);
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    } else if (Date.now() - fs.statSync(lockPath).mtimeMs < RAW_LOG_LOCK_TIMEOUT_MS) {
      return false;
    }
    fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
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

function fsyncPath(targetPath: string): void {
  const descriptor = fs.openSync(targetPath, "r");
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
  for (const line of fs.readFileSync(rawLogPath, "utf8").split(/\r?\n/u)) {
    if (line.trim().length === 0) continue;
    const event = parsePersistedEvent(line);
    if (event) events.push(event);
    else malformedLineCount += 1;
  }
  return { events, malformedLineCount };
}

export function readRawEvents(rawLogPath: string): NormalizedEvent[] {
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
