import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { normalizeHookEvent, type NormalizedEvent } from "./events.ts";
import { type LcmStorage } from "./storage.ts";

export type ImportCodexSessionsOptions = {
  from?: string;
  dryRun?: boolean;
  batchSize?: number;
  progress?: (report: ImportCodexSessionsReport) => void;
};

export type ImportCodexSessionsReport = {
  mode: "dry-run" | "import";
  source: string;
  files_scanned: number;
  records_read: number;
  events_importable: number;
  events_imported: number;
  events_skipped_duplicate: number;
  records_skipped: number;
  duration_ms: number;
  events_per_second: number;
  errors: Array<{ file: string; line?: number; message: string }>;
};

type ImportState = {
  sessionId?: string;
  cwd?: string;
  repoRoot?: string;
  gitBranch?: string;
  turnId?: string;
};

export function defaultCodexSessionsPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

export function importCodexSessions(storage: LcmStorage, options: ImportCodexSessionsOptions = {}): ImportCodexSessionsReport {
  const startedAt = Date.now();
  const source = path.resolve(options.from ?? defaultCodexSessionsPath());
  const report: ImportCodexSessionsReport = {
    mode: options.dryRun ? "dry-run" : "import",
    source,
    files_scanned: 0,
    records_read: 0,
    events_importable: 0,
    events_imported: 0,
    events_skipped_duplicate: 0,
    records_skipped: 0,
    duration_ms: 0,
    events_per_second: 0,
    errors: [],
  };
  const batchSize = Math.max(1, options.batchSize ?? 5000);
  const pendingEvents: NormalizedEvent[] = [];
  const touchedSessions = new Set<string>();
  let lastProgressRecordCount = 0;

  const updateTiming = () => {
    report.duration_ms = Math.max(0, Date.now() - startedAt);
    report.events_per_second = report.duration_ms > 0
      ? Math.round((report.events_imported / (report.duration_ms / 1000)) * 100) / 100
      : 0;
  };
  const emitProgress = (force = false) => {
    if (!options.progress) return;
    if (!force && report.records_read - lastProgressRecordCount < 1000) return;
    updateTiming();
    options.progress(report);
    lastProgressRecordCount = report.records_read;
  };
  const flushBatch = () => {
    if (pendingEvents.length === 0) return;
    const result = storage.ingestMany(pendingEvents.splice(0, pendingEvents.length), { rebuildSummaries: false });
    report.events_imported += result.imported;
    report.events_skipped_duplicate += result.skippedDuplicate;
    for (const sessionId of result.touchedSessions) touchedSessions.add(sessionId);
    emitProgress();
  };

  for (const file of listJsonlFiles(source)) {
    report.files_scanned += 1;
    importFile(file, report, {
      onImportableEvent: (event) => {
        if (options.dryRun) {
          if (storage.hasEvent(event.event_id)) {
            report.events_skipped_duplicate += 1;
          }
          return;
        }
        pendingEvents.push(event);
        if (pendingEvents.length >= batchSize) flushBatch();
      },
      onProgress: emitProgress,
    });
  }
  if (!options.dryRun) flushBatch();
  if (!options.dryRun) storage.rebuildSessionMemorySummaries(touchedSessions);
  updateTiming();
  emitProgress(true);
  return report;
}

function importFile(
  file: string,
  report: ImportCodexSessionsReport,
  options: {
    onImportableEvent: (event: NormalizedEvent) => void;
    onProgress: () => void;
  },
): void {
  const state: ImportState = {};
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().length === 0) continue;
    report.records_read += 1;
    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) throw new Error("record is not an object");
      record = parsed;
    } catch (error) {
      report.records_skipped += 1;
      report.errors.push({ file, line: index + 1, message: error instanceof Error ? error.message : String(error) });
      options.onProgress();
      continue;
    }

    const event = codexRecordToEvent(record, file, state);
    if (!event) {
      report.records_skipped += 1;
      options.onProgress();
      continue;
    }
    report.events_importable += 1;
    options.onImportableEvent(event);
    options.onProgress();
  }
}

function codexRecordToEvent(record: Record<string, unknown>, file: string, state: ImportState): NormalizedEvent | undefined {
  const payload = isRecord(record.payload) ? record.payload : {};
  const type = stringValue(record.type);
  const timestamp = stringValue(record.timestamp) || stringValue(payload.timestamp) || new Date(0).toISOString();

  if (type === "session_meta") {
    state.sessionId = stringValue(payload.id) || state.sessionId || sessionIdFromFile(file);
    state.cwd = stringValue(payload.cwd) || state.cwd || "";
    return normalizeImportEvent({
      hookEvent: "SessionStart",
      timestamp,
      sessionId: state.sessionId,
      cwd: state.cwd || "",
      payload: {
        session_id: state.sessionId,
        cwd: state.cwd || "",
        imported_from: file,
        codex_record_type: type,
        source_timestamp: timestamp,
        metadata: payload,
      },
      state,
    });
  }

  if (type === "turn_context") {
    state.turnId = stringValue(payload.turn_id) || state.turnId;
    state.cwd = stringValue(payload.cwd) || state.cwd;
    state.repoRoot = stringValue(payload.repo_root) || stringValue(payload.repoRoot) || state.repoRoot;
    state.gitBranch = stringValue(payload.git_branch) || stringValue(payload.gitBranch) || state.gitBranch;
    return undefined;
  }

  if (type !== "response_item") return undefined;

  const item = payload;
  const itemType = stringValue(item.type);
  if (itemType === "message") {
    const role = stringValue(item.role);
    const text = contentText(item.content);
    if (text.length === 0 || isSyntheticContextText(text)) return undefined;
    if (role === "user") {
      return normalizeImportEvent({
        hookEvent: "UserPromptSubmit",
        timestamp,
        sessionId: state.sessionId || sessionIdFromFile(file),
        cwd: state.cwd || "",
        payload: basePayload(file, type, timestamp, state, { prompt: text }),
        state,
      });
    }
    if (role === "assistant") {
      return normalizeImportEvent({
        hookEvent: "Stop",
        timestamp,
        sessionId: state.sessionId || sessionIdFromFile(file),
        cwd: state.cwd || "",
        payload: basePayload(file, type, timestamp, state, { last_assistant_message: text }),
        state,
      });
    }
    return undefined;
  }

  if (itemType === "function_call" || itemType === "tool_search_call") {
    const toolName = stringValue(item.name) || itemType;
    const toolUseId = stringValue(item.call_id) || stringValue(item.id);
    return normalizeImportEvent({
      hookEvent: "PreToolUse",
      timestamp,
      sessionId: state.sessionId || sessionIdFromFile(file),
      cwd: state.cwd || "",
      payload: basePayload(file, type, timestamp, state, {
        tool_name: toolName,
        tool_use_id: toolUseId,
        tool_input: parseMaybeJson(item.arguments),
      }),
      state,
    });
  }

  if (itemType === "function_call_output" || itemType === "tool_search_output") {
    return normalizeImportEvent({
      hookEvent: "PostToolUse",
      timestamp,
      sessionId: state.sessionId || sessionIdFromFile(file),
      cwd: state.cwd || "",
      payload: basePayload(file, type, timestamp, state, {
        tool_use_id: stringValue(item.call_id) || stringValue(item.id),
        tool_response: item.output ?? item.tools ?? item,
      }),
      state,
    });
  }

  return undefined;
}

function normalizeImportEvent(args: {
  hookEvent: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  payload: Record<string, unknown>;
  state: ImportState;
}): NormalizedEvent {
  return normalizeHookEvent({
    hookEvent: args.hookEvent,
    rawInput: JSON.stringify({
      ...args.payload,
      session_id: args.sessionId,
      cwd: args.cwd,
      ...(args.state.turnId ? { turn_id: args.state.turnId } : {}),
    }),
    now: () => new Date(args.timestamp),
    repo: {
      repoRoot: args.state.repoRoot,
      gitBranch: args.state.gitBranch,
    },
  });
}

function basePayload(
  file: string,
  type: string,
  timestamp: string,
  state: ImportState,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...fields,
    imported_from: file,
    codex_record_type: type,
    source_timestamp: timestamp,
    ...(state.turnId ? { turn_id: state.turnId } : {}),
  };
}

function listJsonlFiles(source: string): string[] {
  if (!fs.existsSync(source)) return [];
  const stat = fs.statSync(source);
  if (stat.isFile()) return source.endsWith(".jsonl") ? [source] : [];
  const result: string[] = [];
  const stack = [source];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(fullPath);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(fullPath);
    }
  }
  return result.sort((left, right) => left.localeCompare(right));
}

function contentText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value
    .map((entry) => {
      if (!isRecord(entry)) return "";
      return stringValue(entry.text) || "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function isSyntheticContextText(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed.startsWith("<environment_context>") ||
    trimmed.startsWith("<developer") ||
    trimmed.startsWith("<apps_instructions>") ||
    trimmed.startsWith("<skills_instructions>") ||
    trimmed.startsWith("<plugins_instructions>");
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function sessionIdFromFile(file: string): string {
  const base = path.basename(file, ".jsonl");
  const match = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu);
  return match?.[1] || base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
