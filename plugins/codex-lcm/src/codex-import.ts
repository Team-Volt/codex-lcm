import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";

import { codexRecordToEvent, type ImportState, rolloutSessionIdFromFile } from "./codex-record.ts";
import { type NormalizedEvent } from "./events.ts";
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

export function defaultCodexSessionsPath(): string {
  return path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "sessions");
}

export async function importCodexSessions(
  storage: LcmStorage,
  options: ImportCodexSessionsOptions = {},
): Promise<ImportCodexSessionsReport> {
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

  const files = listJsonlFiles(source);
  if (files.length === 0) {
    report.errors.push({ file: source, message: `No JSONL session files found at ${source}` });
  }
  for (const file of files) {
    report.files_scanned += 1;
    await importFile(file, report, {
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

async function importFile(
  file: string,
  report: ImportCodexSessionsReport,
  options: {
    onImportableEvent: (event: NormalizedEvent) => void;
    onProgress: () => void;
  },
): Promise<void> {
  const state: ImportState = {};
  const rolloutSessionId = rolloutSessionIdFromFile(file);
  const input = fs.createReadStream(file, { encoding: "utf8" });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of lines) {
      lineNumber += 1;
      if (line.trim().length === 0) continue;
      report.records_read += 1;
      let event: NormalizedEvent | undefined;
      try {
        const parsed = JSON.parse(line);
        if (!isRecord(parsed)) throw new Error("record is not an object");
        event = codexRecordToEvent(parsed, file, state);
      } catch (error) {
        report.records_skipped += 1;
        report.errors.push({ file, line: lineNumber, message: error instanceof Error ? error.message : String(error) });
        options.onProgress();
        continue;
      }
      if (!event || (rolloutSessionId && event.session_id !== rolloutSessionId)) {
        report.records_skipped += 1;
        options.onProgress();
        continue;
      }
      report.events_importable += 1;
      options.onImportableEvent(event);
      options.onProgress();
    }
  } catch (error) {
    if (!input.errored) throw error;
    report.records_skipped += 1;
    report.errors.push({
      file,
      message: error instanceof Error ? error.message : String(error),
    });
    options.onProgress();
  } finally {
    lines.close();
    input.destroy();
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
