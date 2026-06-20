import path from "node:path";

import type { NormalizedEvent } from "./events.ts";
import { sha256 } from "./redact.ts";

export type FileReference = {
  file_ref_id: string;
  session_id: string;
  observed_event_id: string;
  timestamp: string;
  path: string;
  mime_type: string;
  byte_count: number;
  sha256: string;
  exploration_summary: string;
  metadata: Record<string, unknown>;
};

type Candidate = {
  path: string;
  content?: string;
  byteCount: number;
  hash: string;
  sourcePath: string;
  truncated: boolean;
};

const MIN_FILE_REF_BYTES = 25 * 1024;
const PATH_KEYS = new Set(["path", "file", "file_path", "filepath", "filePath", "filename", "absolute_path", "absolutePath"]);
const CONTENT_KEYS = new Set(["content", "contents", "text", "body", "output", "stdout", "stderr", "tool_response", "result"]);

export function extractFileReferences(event: NormalizedEvent): FileReference[] {
  const candidates = collectCandidates(event.payload, "$.payload");
  const refs = candidates
    .filter((candidate) => candidate.byteCount >= MIN_FILE_REF_BYTES)
    .map((candidate) => candidateToRef(event, candidate));
  return dedupeRefs(refs);
}

function collectCandidates(value: unknown, location: string): Candidate[] {
  if (!isRecord(value)) {
    if (Array.isArray(value)) {
      return value.flatMap((item, index) => collectCandidates(item, `${location}[${index}]`));
    }
    return [];
  }

  const own = candidateFromRecord(value, location);
  const nested = Object.entries(value)
    .flatMap(([key, child]) => collectCandidates(child, `${location}.${key}`));
  return [...own, ...nested];
}

function candidateFromRecord(record: Record<string, unknown>, location: string): Candidate[] {
  const paths = Object.entries(record)
    .filter(([key, value]) => PATH_KEYS.has(key) && typeof value === "string" && isUsefulPath(value))
    .map(([, value]) => value as string);
  if (paths.length === 0) return [];

  const contentEntries = Object.entries(record)
    .filter(([key]) => CONTENT_KEYS.has(key))
    .flatMap(([key, value]) => contentInfo(value, `${location}.${key}`));
  return paths.flatMap((filePath) => contentEntries.map((entry) => ({ path: filePath, ...entry })));
}

function contentInfo(value: unknown, sourcePath: string): Array<Omit<Candidate, "path">> {
  if (typeof value === "string") {
    return [{
      content: value,
      byteCount: Buffer.byteLength(value, "utf8"),
      hash: sha256(value),
      sourcePath,
      truncated: false,
    }];
  }
  if (isRecord(value) && value.lcm_truncated === true && typeof value.sha256 === "string") {
    const originalBytes = typeof value.original_bytes === "number" ? value.original_bytes : 0;
    const preview = typeof value.preview === "string" ? value.preview : undefined;
    return [{
      content: preview,
      byteCount: originalBytes,
      hash: value.sha256,
      sourcePath,
      truncated: true,
    }];
  }
  if (isRecord(value)) {
    return Object.entries(value)
      .filter(([key]) => CONTENT_KEYS.has(key))
      .flatMap(([key, child]) => contentInfo(child, `${sourcePath}.${key}`));
  }
  return [];
}

function candidateToRef(event: NormalizedEvent, candidate: Candidate): FileReference {
  const mimeType = guessMimeType(candidate.path, candidate.content);
  return {
    file_ref_id: `file:${sha256(`${event.session_id}\0${candidate.path}\0${candidate.hash}`).slice(0, 32)}`,
    session_id: event.session_id,
    observed_event_id: event.event_id,
    timestamp: event.timestamp,
    path: candidate.path,
    mime_type: mimeType,
    byte_count: candidate.byteCount,
    sha256: candidate.hash,
    exploration_summary: summarizeContent({
      path: candidate.path,
      mimeType,
      byteCount: candidate.byteCount,
      content: candidate.content,
      truncated: candidate.truncated,
    }),
    metadata: {
      source_path: candidate.sourcePath,
      truncated: candidate.truncated,
    },
  };
}

function dedupeRefs(refs: FileReference[]): FileReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    if (seen.has(ref.file_ref_id)) return false;
    seen.add(ref.file_ref_id);
    return true;
  });
}

function summarizeContent(args: {
  path: string;
  mimeType: string;
  byteCount: number;
  content?: string;
  truncated: boolean;
}): string {
  const size = `${args.byteCount} bytes`;
  const truncation = args.truncated ? " Stored payload was already truncated; summary uses the available preview." : "";
  if (!args.content) return `${args.mimeType} file at ${args.path}, ${size}.${truncation}`;

  if (args.mimeType === "application/json") {
    const json = safeJson(args.content);
    if (Array.isArray(json)) return `JSON array file at ${args.path}, ${size}. Items: ${json.length}.${truncation}`;
    if (isRecord(json)) return `JSON object file at ${args.path}, ${size}. Keys: ${Object.keys(json).slice(0, 8).join(", ") || "none"}.${truncation}`;
  }

  if (args.mimeType === "text/csv") {
    const lines = args.content.split(/\r?\n/u).filter((line) => line.trim().length > 0);
    const columns = lines[0]?.split(",").map((item) => item.trim()).filter(Boolean).slice(0, 8) ?? [];
    return `CSV file at ${args.path}, ${size}. Columns: ${columns.join(", ") || "unknown"}. Rows sampled: ${Math.max(0, lines.length - 1)}.${truncation}`;
  }

  if (args.mimeType.startsWith("text/x-")) {
    const names = [...args.content.matchAll(/\b(?:function|class|interface|type|def)\s+([A-Za-z0-9_$]+)/gu)]
      .map((match) => match[1])
      .slice(0, 8);
    return `Code file at ${args.path}, ${size}. Symbols: ${names.join(", ") || "none detected"}.${truncation}`;
  }

  const preview = args.content.replace(/\s+/gu, " ").trim().slice(0, 220);
  return `Text file at ${args.path}, ${size}. Preview: ${preview || "empty"}.${truncation}`;
}

function guessMimeType(filePath: string, content?: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".json" || looksLikeJson(content)) return "application/json";
  if (ext === ".csv") return "text/csv";
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) return "text/x-typescript";
  if ([".py", ".rb", ".go", ".rs", ".swift", ".java", ".kt", ".c", ".cc", ".cpp", ".h"].includes(ext)) return "text/x-code";
  if ([".md", ".txt", ".log", ".yaml", ".yml", ".toml", ".sql", ".xml", ".html", ".css"].includes(ext)) return "text/plain";
  return "application/octet-stream";
}

function looksLikeJson(value: string | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function isUsefulPath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  return trimmed.includes("/") || trimmed.includes("\\") || /\.[A-Za-z0-9]{1,12}$/u.test(trimmed);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
