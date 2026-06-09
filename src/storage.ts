import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { loadConfig, type LcmConfig } from "./config.ts";
import { createNoteEvent, type NormalizedEvent } from "./events.ts";

export type StorageOptions = {
  home?: string;
  config?: LcmConfig;
};

export type SearchSessionArgs = {
  query?: string;
  limit?: number;
  cwd?: string;
  repoRoot?: string;
};

export type SessionSummary = {
  session_id: string;
  first_seen: string;
  last_seen: string;
  cwd: string;
  repo_root?: string;
  git_branch?: string;
  event_count: number;
  match_count?: number;
};

export type SessionDetail = {
  session: SessionSummary | undefined;
  events: NormalizedEvent[];
};

export type RecentContext = {
  session_id?: string;
  events: NormalizedEvent[];
};

export type PackedContext = {
  markdown: string;
  estimated_tokens: number;
  sources: Array<{ kind: "event" | "note"; session_id: string; event_id: string; timestamp: string }>;
};

export type Health = {
  home: string;
  raw_log_path: string;
  index_path: string;
  raw_log_exists: boolean;
  index_exists: boolean;
  index_available: boolean;
  index_error?: string;
  event_count: number;
  session_count: number;
};

export class LcmStorage {
  readonly config: LcmConfig;
  private db?: DatabaseSync;
  private indexError?: string;

  constructor(options: StorageOptions = {}) {
    this.config = options.config ?? loadConfig({ home: options.home });
    fs.mkdirSync(this.config.home, { recursive: true, mode: 0o700 });
    try {
      this.db = new DatabaseSync(this.config.indexPath);
      this.initialize();
    } catch (error) {
      this.db = undefined;
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  close(): void {
    this.db?.close();
  }

  ingest(event: NormalizedEvent): void {
    fs.mkdirSync(path.dirname(this.config.rawLogPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(this.config.rawLogPath, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (!this.db) return;
    try {
      this.indexEvent(event);
    } catch (error) {
      this.indexError = error instanceof Error ? error.message : String(error);
    }
  }

  health(): Health {
    const rawEvents = this.db ? undefined : readRawEvents(this.config.rawLogPath);
    return {
      home: this.config.home,
      raw_log_path: this.config.rawLogPath,
      index_path: this.config.indexPath,
      raw_log_exists: fs.existsSync(this.config.rawLogPath),
      index_exists: fs.existsSync(this.config.indexPath),
      index_available: this.db !== undefined,
      ...(this.indexError ? { index_error: this.indexError } : {}),
      event_count: this.db ? Number(this.scalar("SELECT COUNT(*) AS count FROM events")) : rawEvents?.length ?? 0,
      session_count: this.db ? Number(this.scalar("SELECT COUNT(*) AS count FROM sessions")) : summarizeSessions(rawEvents ?? []).length,
    };
  }

  searchSessions(args: SearchSessionArgs): SessionSummary[] {
    const limit = clampLimit(args.limit, 10);
    if (!this.db) {
      const query = args.query?.trim().toLowerCase() ?? "";
      return summarizeSessions(readRawEvents(this.config.rawLogPath)
        .filter((event) => !args.cwd || event.cwd === args.cwd)
        .filter((event) => !args.repoRoot || event.repo_root === args.repoRoot)
        .filter((event) => query.length === 0 || JSON.stringify(event).toLowerCase().includes(query)))
        .slice(0, limit);
    }
    const query = args.query?.trim() ?? "";
    if (query.length === 0) {
      return this.db.prepare(`
        SELECT session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count
        FROM sessions
        WHERE (?1 IS NULL OR cwd = ?1)
          AND (?2 IS NULL OR repo_root = ?2)
        ORDER BY last_seen DESC
        LIMIT ?3
      `).all(args.cwd ?? null, args.repoRoot ?? null, limit).map(rowToSessionSummary);
    }

    const ftsQuery = toFtsQuery(query);
    const rows = this.db.prepare(`
      SELECT s.session_id, s.first_seen, s.last_seen, s.cwd, s.repo_root, s.git_branch, s.event_count,
             COUNT(e.event_id) AS match_count,
             MAX(e.timestamp) AS last_match_at
      FROM event_fts f
      JOIN events e ON e.event_id = f.event_id
      JOIN sessions s ON s.session_id = e.session_id
      WHERE event_fts MATCH ?1
        AND (?2 IS NULL OR s.cwd = ?2)
        AND (?3 IS NULL OR s.repo_root = ?3)
      GROUP BY s.session_id
      ORDER BY last_match_at DESC
      LIMIT ?4
    `).all(ftsQuery, args.cwd ?? null, args.repoRoot ?? null, limit);
    return rows.map(rowToSessionSummary);
  }

  getCurrentSession(args: { sessionId?: string; cwd?: string; repoRoot?: string } = {}): SessionSummary | undefined {
    if (args.sessionId) return this.getSessionSummary(args.sessionId);
    if (!this.db) {
      return summarizeSessions(readRawEvents(this.config.rawLogPath)
        .filter((event) => !args.cwd || event.cwd === args.cwd)
        .filter((event) => !args.repoRoot || event.repo_root === args.repoRoot))[0];
    }
    const row = this.db.prepare(`
      SELECT session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count
      FROM sessions
      WHERE (?1 IS NULL OR cwd = ?1)
        AND (?2 IS NULL OR repo_root = ?2)
      ORDER BY last_seen DESC
      LIMIT 1
    `).get(args.cwd ?? null, args.repoRoot ?? null);
    return row ? rowToSessionSummary(row) : undefined;
  }

  getSession(sessionId: string): SessionDetail {
    const session = this.getSessionSummary(sessionId);
    if (!this.db) {
      return {
        session,
        events: readRawEvents(this.config.rawLogPath).filter((event) => event.session_id === sessionId),
      };
    }
    const events = this.db.prepare(`
      SELECT raw_json FROM events
      WHERE session_id = ?1
      ORDER BY timestamp ASC, rowid ASC
    `).all(sessionId).map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent);
    return { session, events };
  }

  getRecentContext(args: { sessionId?: string; cwd?: string; repoRoot?: string; limit?: number } = {}): RecentContext {
    const session = this.getCurrentSession({
      sessionId: args.sessionId,
      cwd: args.cwd,
      repoRoot: args.repoRoot,
    });
    if (!session) return { events: [] };
    const limit = clampLimit(args.limit, 20);
    if (!this.db) {
      const events = readRawEvents(this.config.rawLogPath)
        .filter((event) => event.session_id === session.session_id)
        .slice(-limit);
      return { session_id: session.session_id, events };
    }
    const rows = this.db.prepare(`
      SELECT raw_json FROM (
        SELECT raw_json, timestamp, rowid
        FROM events
        WHERE session_id = ?1
        ORDER BY timestamp DESC, rowid DESC
        LIMIT ?2
      )
      ORDER BY timestamp ASC, rowid ASC
    `).all(session.session_id, limit);
    return {
      session_id: session.session_id,
      events: rows.map((row) => JSON.parse((row as { raw_json: string }).raw_json) as NormalizedEvent),
    };
  }

  recordNote(args: { sessionId: string; cwd: string; text: string }): NormalizedEvent {
    const event = createNoteEvent({
      sessionId: args.sessionId,
      cwd: args.cwd,
      text: args.text,
    });
    this.ingest(event);
    return event;
  }

  packContext(args: { query?: string; sessionIds?: string[]; budgetTokens?: number; cwd?: string } = {}): PackedContext {
    const budgetTokens = Math.max(16, args.budgetTokens ?? 1200);
    const budgetChars = budgetTokens * 4;
    const candidates: NormalizedEvent[] = [];

    if (args.sessionIds?.length) {
      for (const sessionId of args.sessionIds) {
        candidates.push(...this.getRecentContext({ sessionId, limit: 50 }).events);
      }
    } else {
      const sessions = this.searchSessions({ query: args.query, cwd: args.cwd, limit: 8 });
      for (const session of sessions) {
        candidates.push(...this.getRecentContext({ sessionId: session.session_id, limit: 12 }).events);
      }
    }

    const lines = ["# Codex LCM Context", ""];
    const sources: PackedContext["sources"] = [];
    let chars = lines.join("\n").length;
    for (const event of candidates) {
      const text = eventToMarkdown(event);
      if (chars + text.length > budgetChars) break;
      lines.push(text);
      chars += text.length;
      sources.push({
        kind: event.hook_event === "Note" ? "note" : "event",
        session_id: event.session_id,
        event_id: event.event_id,
        timestamp: event.timestamp,
      });
    }

    return {
      markdown: lines.join("\n"),
      estimated_tokens: Math.ceil(chars / 4),
      sources,
    };
  }

  private initialize(): void {
    if (!this.db) return;
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT,
        git_branch TEXT,
        event_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS events (
        event_id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        hook_event TEXT NOT NULL,
        cwd TEXT NOT NULL,
        repo_root TEXT,
        git_branch TEXT,
        text TEXT NOT NULL,
        raw_json TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
        event_id UNINDEXED,
        session_id,
        cwd,
        repo_root,
        hook_event,
        content
      );
    `);
  }

  private indexEvent(event: NormalizedEvent): void {
    if (!this.db) return;
    const raw = JSON.stringify(event);
    const text = eventSearchText(event);
    const insert = this.db.prepare(`
      INSERT OR IGNORE INTO events
        (event_id, session_id, timestamp, hook_event, cwd, repo_root, git_branch, text, raw_json)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
    `).run(
      event.event_id,
      event.session_id,
      event.timestamp,
      event.hook_event,
      event.cwd,
      event.repo_root ?? null,
      event.git_branch ?? null,
      text,
      raw,
    );
    if ((insert as { changes?: number }).changes === 0) return;
    this.db.prepare(`
      INSERT INTO sessions (session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count)
      VALUES (?1, ?2, ?2, ?3, ?4, ?5, 1)
      ON CONFLICT(session_id) DO UPDATE SET
        last_seen = CASE WHEN excluded.last_seen > sessions.last_seen THEN excluded.last_seen ELSE sessions.last_seen END,
        cwd = excluded.cwd,
        repo_root = COALESCE(excluded.repo_root, sessions.repo_root),
        git_branch = COALESCE(excluded.git_branch, sessions.git_branch),
        event_count = sessions.event_count + 1
    `).run(
      event.session_id,
      event.timestamp,
      event.cwd,
      event.repo_root ?? null,
      event.git_branch ?? null,
    );
    this.db.prepare(`
      INSERT INTO event_fts (event_id, session_id, cwd, repo_root, hook_event, content)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    `).run(
      event.event_id,
      event.session_id,
      event.cwd,
      event.repo_root ?? "",
      event.hook_event,
      text,
    );
  }

  private getSessionSummary(sessionId: string): SessionSummary | undefined {
    if (!this.db) {
      return summarizeSessions(readRawEvents(this.config.rawLogPath).filter((event) => event.session_id === sessionId))[0];
    }
    const row = this.db.prepare(`
      SELECT session_id, first_seen, last_seen, cwd, repo_root, git_branch, event_count
      FROM sessions
      WHERE session_id = ?1
    `).get(sessionId);
    return row ? rowToSessionSummary(row) : undefined;
  }

  private scalar(sql: string): number {
    if (!this.db) return 0;
    const row = this.db.prepare(sql).get() as { count: number };
    return row.count;
  }
}

export function createStorage(options: StorageOptions = {}): LcmStorage {
  return new LcmStorage(options);
}

function rowToSessionSummary(row: unknown): SessionSummary {
  const record = row as Record<string, unknown>;
  return {
    session_id: String(record.session_id),
    first_seen: String(record.first_seen),
    last_seen: String(record.last_seen),
    cwd: String(record.cwd),
    ...(record.repo_root ? { repo_root: String(record.repo_root) } : {}),
    ...(record.git_branch ? { git_branch: String(record.git_branch) } : {}),
    event_count: Number(record.event_count),
    ...(record.match_count !== undefined ? { match_count: Number(record.match_count) } : {}),
  };
}

function clampLimit(limit: number | undefined, fallback: number): number {
  return Math.min(Math.max(Number(limit ?? fallback), 1), 200);
}

function toFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function eventSearchText(event: NormalizedEvent): string {
  return [
    event.hook_event,
    event.session_id,
    event.cwd,
    event.repo_root,
    event.git_branch,
    JSON.stringify(event.payload),
  ].filter(Boolean).join("\n");
}

function eventToMarkdown(event: NormalizedEvent): string {
  const payload = JSON.stringify(event.payload);
  return [
    `## ${event.timestamp} ${event.hook_event}`,
    `session: ${event.session_id}`,
    `cwd: ${event.cwd}`,
    payload,
    "",
  ].join("\n");
}

function readRawEvents(rawLogPath: string): NormalizedEvent[] {
  if (!fs.existsSync(rawLogPath)) return [];
  return fs.readFileSync(rawLogPath, "utf8")
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as NormalizedEvent];
      } catch {
        return [];
      }
    });
}

function summarizeSessions(events: NormalizedEvent[]): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();
  for (const event of events) {
    const existing = sessions.get(event.session_id);
    if (!existing) {
      sessions.set(event.session_id, {
        session_id: event.session_id,
        first_seen: event.timestamp,
        last_seen: event.timestamp,
        cwd: event.cwd,
        ...(event.repo_root ? { repo_root: event.repo_root } : {}),
        ...(event.git_branch ? { git_branch: event.git_branch } : {}),
        event_count: 1,
        match_count: 1,
      });
      continue;
    }
    existing.first_seen = event.timestamp < existing.first_seen ? event.timestamp : existing.first_seen;
    existing.last_seen = event.timestamp > existing.last_seen ? event.timestamp : existing.last_seen;
    existing.cwd = event.cwd;
    existing.repo_root = event.repo_root ?? existing.repo_root;
    existing.git_branch = event.git_branch ?? existing.git_branch;
    existing.event_count += 1;
    existing.match_count = (existing.match_count ?? 0) + 1;
  }
  return [...sessions.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}
