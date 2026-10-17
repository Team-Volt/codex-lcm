import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

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

const READ_BYTES = 64 * 1024;

export async function classifySessionFile(file: string, onProgress?: () => void): Promise<ClassifiedSessionFile> {
  const classifier = createSessionSourceClassifier(file);
  try {
    for await (const record of readJsonlRecords(file, onProgress)) classifier.observe(record);
  } catch (error) {
    classifier.fail(error instanceof Error ? error.message : String(error));
  }
  return classifier.result();
}

export function createSessionSourceClassifier(file: string) {
  const kinds = new Set<SessionSourceKind>();
  if (rolloutSessionIdFromFile(file)) kinds.add("uuid-rollout");

  let sawKnownRecord = false;
  let reason: string | undefined;
  return {
    observe(record: unknown): void {
      if (reason !== undefined || !isRecord(record)) return;
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
    },
    fail(message: string): void {
      reason ??= message;
    },
    result(): ClassifiedSessionFile {
      if (kinds.size === 0 && !sawKnownRecord) {
        return { path: file, kinds: [], unclassified: true, reason: reason ?? "no known Codex session shape" };
      }
      return { path: file, kinds: SESSION_SOURCE_KINDS.filter((kind) => kinds.has(kind)), unclassified: false, ...(reason ? { reason } : {}) };
    },
  };
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

// Scan through EOF: an absent kind must not mean an exhausted prefix budget.
async function* readJsonlRecords(file: string, onProgress?: () => void): AsyncGenerator<unknown> {
  const fd = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(READ_BYTES);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    let lineNumber = 0;
    const parse = (line: string): unknown => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`invalid JSON on line ${lineNumber} of ${path.basename(file)}`);
      }
    };
    while (true) {
      const { bytesRead } = await fd.read(buffer, 0, buffer.length, null);
      onProgress?.();
      pending += bytesRead === 0 ? decoder.end() : decoder.write(buffer.subarray(0, bytesRead));
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        lineNumber += 1;
        if (line.trim().length > 0) yield parse(line);
      }
      if (bytesRead === 0) {
        lineNumber += 1;
        if (pending.trim().length > 0) yield parse(pending);
        break;
      }
    }
  } finally {
    await fd.close();
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
