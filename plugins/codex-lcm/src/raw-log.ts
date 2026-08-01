import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { threadId } from "node:worker_threads";

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
const activeRawLogLockTokens = new Set<string>();

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
  const lockPath = `${rawLogPath}.lock`;
  const coordinatorPath = `${rawLogPath}.lock.sqlite`;
  const token = `${process.pid}:${threadId}:${randomUUID()}`;
  const deadline = Date.now() + RAW_LOG_LOCK_TIMEOUT_MS;
  let descriptor: number;

  const coordinator = new DatabaseSync(coordinatorPath, { timeout: RAW_LOG_LOCK_POLL_MS });
  try {
    fs.chmodSync(coordinatorPath, 0o600);
    while (true) {
      const acquired = tryAcquireRawLogLock(coordinator, lockPath);
      if (acquired !== undefined) {
        descriptor = acquired;
        break;
      }
      if (Date.now() >= deadline) throw new RawLogLockTimeoutError(lockPath);
      Atomics.wait(RAW_LOG_LOCK_WAIT, 0, 0, RAW_LOG_LOCK_POLL_MS);
    }
  } finally {
    coordinator.close();
  }

  try {
    fs.writeFileSync(descriptor, token);
    activeRawLogLockTokens.add(token);
  } catch (error) {
    try {
      fs.closeSync(descriptor);
    } catch {}
    try {
      fs.unlinkSync(lockPath);
    } catch {}
    throw error;
  }

  // ponytail: one writer lock is enough; shard only if raw-log contention becomes measurable.
  try {
    return callback();
  } finally {
    try {
      fs.closeSync(descriptor);
      if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      activeRawLogLockTokens.delete(token);
    }
  }
}

function tryAcquireRawLogLock(coordinator: DatabaseSync, lockPath: string): number | undefined {
  let transactionOpen = false;
  try {
    try {
      coordinator.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
    } catch (error) {
      if (isSqliteBusy(error)) return undefined;
      throw error;
    }
    try {
      return fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!clearStaleRawLogLock(lockPath)) return undefined;
      try {
        return fs.openSync(lockPath, "wx", 0o600);
      } catch (retryError) {
        if ((retryError as NodeJS.ErrnoException).code === "EEXIST") return undefined;
        throw retryError;
      }
    }
  } finally {
    if (transactionOpen) coordinator.exec("ROLLBACK");
  }
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
    fsyncPath(rawLogPath);
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

function clearStaleRawLogLock(lockPath: string): boolean {
  try {
    const token = fs.readFileSync(lockPath, "utf8");
    const [ownerText, ownerThreadText] = token.split(":", 2);
    const owner = Number(ownerText);
    if (Number.isSafeInteger(owner) && owner > 0) {
      if (owner === process.pid) {
        const ownerThread = Number(ownerThreadText);
        if (!Number.isSafeInteger(ownerThread) || ownerThread < 0 || ownerThread !== threadId) return false;
        if (activeRawLogLockTokens.has(token)) return false;
      } else {
        try {
          process.kill(owner, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
        }
      }
    } else {
      return false;
    }
    if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function restoreRawLog(rawLogPath: string, existed: boolean, previousSize: number): void {
  if (existed) {
    fs.truncateSync(rawLogPath, previousSize);
    fsyncPath(rawLogPath);
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
