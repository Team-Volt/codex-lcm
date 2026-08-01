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
const RAW_LOG_LOCK_TOKEN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

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
  const tokenId = randomUUID();
  const token = `${process.pid}:${threadId}:${tokenId}`;
  const candidatePath = `${lockPath}.${tokenId}.candidate`;
  const deadline = Date.now() + RAW_LOG_LOCK_TIMEOUT_MS;
  let coordinator: DatabaseSync | undefined;
  let transactionOpen = false;
  let published = false;

  fs.writeFileSync(candidatePath, token, { flag: "wx", mode: 0o600 });
  try {
    coordinator = new DatabaseSync(coordinatorPath, { timeout: RAW_LOG_LOCK_POLL_MS });
    fs.chmodSync(coordinatorPath, 0o600);
    while (!published) {
      if (!transactionOpen) {
        try {
          coordinator.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
        } catch (error) {
          if (!isSqliteBusy(error)) throw error;
          waitForRawLogLock(deadline, lockPath);
          continue;
        }
      }
      try {
        fs.linkSync(candidatePath, lockPath);
        published = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (clearStaleRawLogLock(lockPath)) continue;
        coordinator.exec("ROLLBACK");
        transactionOpen = false;
        waitForRawLogLock(deadline, lockPath);
      }
    }
    fs.unlinkSync(candidatePath);

    // ponytail: one writer lock is enough; shard only if raw-log contention becomes measurable.
    return callback();
  } finally {
    try {
      if (published && fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      if (transactionOpen) coordinator?.exec("ROLLBACK");
      coordinator?.close();
      try {
        fs.unlinkSync(candidatePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
}

function waitForRawLogLock(deadline: number, lockPath: string): void {
  if (Date.now() >= deadline) throw new RawLogLockTimeoutError(lockPath);
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
    const tokenParts = token.split(":");
    const [ownerText, ownerThreadText, tokenId] = tokenParts;
    const owner = Number(ownerText);
    const ownerThread = Number(ownerThreadText);
    const currentToken = tokenParts.length === 3
      && Number.isSafeInteger(owner)
      && owner > 0
      && Number.isSafeInteger(ownerThread)
      && ownerThread >= 0
      && typeof tokenId === "string"
      && RAW_LOG_LOCK_TOKEN_ID_PATTERN.test(tokenId);
    if (currentToken) {
      if (fs.readFileSync(lockPath, "utf8") === token) fs.unlinkSync(lockPath);
      return true;
    }
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
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
