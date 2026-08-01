import fs from "node:fs";
import path from "node:path";

import type { NormalizedEvent } from "./events.ts";
import { sha256 } from "./redact.ts";

export const DEFAULT_OVERFLOW_READ_BYTES = 64 * 1024;
export const MAX_OVERFLOW_READ_BYTES = 512 * 1024;

export type OverflowReference = {
  file_ref_id: string;
  session_id: string;
  observed_event_id: string;
  timestamp: string;
  path: string;
  sha256: string;
  byte_count: number;
  sanitized_byte_count: number;
};

export type OverflowContent = OverflowReference & {
  offset: number;
  content: string;
  next_offset?: number;
};

export type OverflowSearchMatch = {
  file_ref_id: string;
  session_id: string;
  timestamp: string;
  byte_offset: number;
  line_number: number;
  snippet: string;
  scan_truncated: boolean;
};

export function overflowReferenceFromEvent(event: NormalizedEvent): OverflowReference | undefined {
  const value = event.payload.overflow_ref;
  if (!isRecord(value)) return undefined;
  const hash = stringValue(value.sha256);
  const filePath = stringValue(value.path);
  const byteCount = numberValue(value.byte_count);
  const sanitizedByteCount = numberValue(value.sanitized_byte_count);
  if (!hash || !/^[a-f0-9]{64}$/u.test(hash) || !filePath || byteCount === undefined || sanitizedByteCount === undefined) {
    return undefined;
  }
  return {
    file_ref_id: `overflow:${hash}`,
    session_id: event.session_id,
    observed_event_id: event.event_id,
    timestamp: event.timestamp,
    path: filePath,
    sha256: hash,
    byte_count: byteCount,
    sanitized_byte_count: sanitizedByteCount,
  };
}

export function readOverflowContent(args: {
  overflowDir: string;
  reference: OverflowReference;
  offset?: number;
  maxBytes?: number;
}): OverflowContent {
  const buffer = readVerifiedOverflowBuffer(args);
  const requestedOffset = clampInteger(args.offset, 0, buffer.length, 0);
  const maxBytes = clampInteger(args.maxBytes, 4, MAX_OVERFLOW_READ_BYTES, DEFAULT_OVERFLOW_READ_BYTES);
  const offset = nextUtf8Boundary(buffer, requestedOffset);
  const end = previousUtf8Boundary(buffer, Math.min(buffer.length, offset + maxBytes));
  return {
    ...args.reference,
    offset,
    content: buffer.subarray(offset, end).toString("utf8"),
    ...(end < buffer.length ? { next_offset: end } : {}),
  };
}

function readVerifiedOverflowBuffer(args: {
  overflowDir: string;
  reference: OverflowReference;
  maxFileBytes?: number;
  onRead?: (bytes: number) => void;
}): Buffer {
  const expectedPath = path.join(path.resolve(args.overflowDir), `${args.reference.sha256}.json`);
  if (path.resolve(args.reference.path) !== expectedPath) {
    throw new Error("Overflow reference is outside the managed overflow directory.");
  }
  const file = fs.openSync(expectedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(file);
    if (!stat.isFile() || stat.size !== args.reference.sanitized_byte_count || stat.size > 16 * 1024 * 1024) {
      throw new Error("Overflow reference does not match a bounded regular file.");
    }
    if (args.maxFileBytes !== undefined && stat.size > args.maxFileBytes) {
      throw new Error("Overflow payload exceeds the remaining search budget.");
    }
    args.onRead?.(stat.size);
    const buffer = fs.readFileSync(file);
    if (sha256(buffer) !== args.reference.sha256) throw new Error("Overflow payload integrity check failed.");
    return buffer;
  } finally {
    fs.closeSync(file);
  }
}

export function searchOverflowContent(args: {
  overflowDir: string;
  reference: OverflowReference;
  query: string;
  maxScanBytes?: number;
  onRead?: (bytes: number) => void;
}): OverflowSearchMatch | undefined {
  const query = args.query.trim();
  if (query.length === 0) return undefined;
  const content = readVerifiedOverflowBuffer({
    overflowDir: args.overflowDir,
    reference: args.reference,
    maxFileBytes: args.maxScanBytes,
    onRead: args.onRead,
  }).toString("utf8");
  const index = content.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return undefined;
  const byteOffset = Buffer.byteLength(content.slice(0, index), "utf8");
  const snippetStart = Math.max(0, index - 120);
  const snippetEnd = Math.min(content.length, index + query.length + 120);
  return {
    file_ref_id: args.reference.file_ref_id,
    session_id: args.reference.session_id,
    timestamp: args.reference.timestamp,
    byte_offset: byteOffset,
    line_number: content.slice(0, index).split(/\r?\n/u).length,
    snippet: content.slice(snippetStart, snippetEnd).replace(/\s+/gu, " ").trim(),
    scan_truncated: false,
  };
}

function nextUtf8Boundary(buffer: Buffer, offset: number): number {
  let index = offset;
  while (index < buffer.length && (buffer[index] & 0xc0) === 0x80) index += 1;
  return index;
}

function previousUtf8Boundary(buffer: Buffer, offset: number): number {
  let index = offset;
  while (index > 0 && index < buffer.length && (buffer[index] & 0xc0) === 0x80) index -= 1;
  return index;
}

function clampInteger(value: number | undefined, min: number, max: number, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
