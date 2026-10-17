import fs from "node:fs";
import path from "node:path";

import { rolloutSessionIdFromFile } from "./codex-record.ts";

export const SESSION_SOURCE_KINDS = [
  "uuid-rollout",
  "current-codex-record",
  "subagent-transcript",
  "forked-rollout-with-lineage",
] as const;

export type SessionSourceKind = (typeof SESSION_SOURCE_KINDS)[number];

export const CODEX_RECORD_TYPES = [
  "session_meta",
  "turn_context",
  "compacted",
  "event_msg",
  "response_item",
] as const;

export type ClassifiedSessionFile = {
  readonly path: string;
  readonly kinds: readonly SessionSourceKind[];
  readonly unclassified: boolean;
  readonly reason?: string;
};

const PEEK_BYTES = 64 * 1024;

export function classifySessionFile(file: string): ClassifiedSessionFile {
  const kinds = new Set<SessionSourceKind>();
  if (rolloutSessionIdFromFile(file)) kinds.add("uuid-rollout");

  let records: unknown[];
  try {
    records = peekJsonlRecords(file);
  } catch (error) {
    return {
      path: file,
      kinds: [...kinds],
      unclassified: kinds.size === 0,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let sawKnownRecord = false;
  for (const record of records) {
    if (!isRecord(record)) continue;
    const type = record.type;
    if (typeof type === "string" && (CODEX_RECORD_TYPES as readonly string[]).includes(type)) {
      sawKnownRecord = true;
    }
    if (type === "response_item") kinds.add("current-codex-record");
    if (type === "session_meta" && isRecord(record.payload)) {
      const payload = record.payload;
      if (hasSubagentSource(payload)) kinds.add("subagent-transcript");
      if (typeof payload.parent_thread_id === "string" && payload.parent_thread_id.trim().length > 0) {
        kinds.add("forked-rollout-with-lineage");
      }
    }
  }

  if (kinds.size === 0 && !sawKnownRecord) {
    return { path: file, kinds: [], unclassified: true, reason: "no known Codex session shape" };
  }
  return { path: file, kinds: SESSION_SOURCE_KINDS.filter((kind) => kinds.has(kind)), unclassified: false };
}

export function missingSessionSourceKinds(
  classified: readonly ClassifiedSessionFile[],
): SessionSourceKind[] {
  const seen = new Set<SessionSourceKind>();
  for (const file of classified) {
    for (const kind of file.kinds) seen.add(kind);
  }
  return SESSION_SOURCE_KINDS.filter((kind) => !seen.has(kind));
}

function peekJsonlRecords(file: string): unknown[] {
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(PEEK_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, PEEK_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    if (bytesRead === PEEK_BYTES && !text.endsWith("\n")) lines.pop();
    return lines.map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`invalid JSON on line ${index + 1} of ${path.basename(file)}`);
      }
    });
  } finally {
    fs.closeSync(fd);
  }
}

function hasSubagentSource(payload: Record<string, unknown>): boolean {
  const source = payload.source;
  if (!isRecord(source)) return false;
  return isRecord(source.subagent);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
