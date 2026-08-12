import type { DatabaseSync } from "node:sqlite";

import { SUMMARY_ALGORITHM_VERSION, SUMMARY_NODE_VERSION } from "./summary.ts";

export type SchemaInitialization = {
  readonly backfillSessionMetadata: boolean;
};

export function initializeStorageSchema(db: DatabaseSync): SchemaInitialization {
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      first_seen TEXT NOT NULL,
      last_seen TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repo_root TEXT,
      git_branch TEXT,
      event_count INTEGER NOT NULL DEFAULT 0,
      parent_session_id TEXT,
      agent_role TEXT,
      agent_nickname TEXT,
      model TEXT,
      reasoning_effort TEXT,
      total_input_tokens INTEGER,
      cached_input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_output_tokens INTEGER,
      total_tokens INTEGER
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      hook_event TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repo_root TEXT,
      git_branch TEXT,
      turn_id TEXT,
      tool_use_id TEXT,
      text TEXT NOT NULL DEFAULT '',
      raw_json TEXT NOT NULL,
      segment_id TEXT,
      raw_offset INTEGER,
      raw_length INTEGER,
      agent_id TEXT,
      overflow_sha256 TEXT
    );
    CREATE TABLE IF NOT EXISTS session_summaries (
      session_id TEXT PRIMARY KEY,
      summary_version INTEGER NOT NULL DEFAULT ${SUMMARY_ALGORITHM_VERSION},
      updated_at TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repo_root TEXT,
      git_branch TEXT,
      title TEXT NOT NULL,
      overview TEXT NOT NULL,
      topics_json TEXT NOT NULL,
      key_prompts_json TEXT NOT NULL,
      outcomes_json TEXT NOT NULL,
      tools_json TEXT NOT NULL,
      source_event_ids_json TEXT NOT NULL,
      summary_text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS summary_nodes (
      node_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      summary_version INTEGER NOT NULL DEFAULT ${SUMMARY_NODE_VERSION},
      depth INTEGER NOT NULL,
      summary_text TEXT NOT NULL,
      token_count INTEGER NOT NULL,
      source_token_count INTEGER NOT NULL,
      source_type TEXT NOT NULL,
      source_ids_json TEXT NOT NULL,
      source_event_ids_json TEXT NOT NULL,
      earliest_at TEXT NOT NULL,
      latest_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      cwd TEXT NOT NULL,
      repo_root TEXT,
      git_branch TEXT,
      topics_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS file_refs (
      file_ref_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      observed_event_id TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_count INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      exploration_summary TEXT NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS index_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_session_summaries_updated ON session_summaries(updated_at);
    CREATE INDEX IF NOT EXISTS idx_summary_nodes_session_depth_latest ON summary_nodes(session_id, depth, latest_at);
    CREATE INDEX IF NOT EXISTS idx_summary_nodes_session_latest ON summary_nodes(session_id, latest_at);
    CREATE INDEX IF NOT EXISTS idx_file_refs_session_time ON file_refs(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_file_refs_path ON file_refs(path);
  `);
  createSearchIndexTables(db);
  ensureColumn(db, "events", "turn_id", "TEXT");
  ensureColumn(db, "events", "tool_use_id", "TEXT");
  ensureColumn(db, "events", "segment_id", "TEXT");
  ensureColumn(db, "events", "raw_offset", "INTEGER");
  ensureColumn(db, "events", "raw_length", "INTEGER");
  ensureColumn(db, "events", "agent_id", "TEXT");
  ensureColumn(db, "events", "overflow_sha256", "TEXT");
  ensureColumn(db, "session_summaries", "summary_version", "INTEGER");
  const backfillSessionMetadata = [
    ensureColumn(db, "sessions", "parent_session_id", "TEXT"),
    ensureColumn(db, "sessions", "agent_role", "TEXT"),
    ensureColumn(db, "sessions", "agent_nickname", "TEXT"),
    ensureColumn(db, "sessions", "model", "TEXT"),
    ensureColumn(db, "sessions", "reasoning_effort", "TEXT"),
    ensureColumn(db, "sessions", "total_input_tokens", "INTEGER"),
    ensureColumn(db, "sessions", "cached_input_tokens", "INTEGER"),
    ensureColumn(db, "sessions", "output_tokens", "INTEGER"),
    ensureColumn(db, "sessions", "reasoning_output_tokens", "INTEGER"),
    ensureColumn(db, "sessions", "total_tokens", "INTEGER"),
  ].some(Boolean);
  db.exec(`
    DROP TABLE IF EXISTS graph_edges;
    DROP TABLE IF EXISTS graph_nodes;
    CREATE INDEX IF NOT EXISTS idx_events_session_turn ON events(session_id, turn_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_tool_use ON events(session_id, tool_use_id, hook_event, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_session_hook_time ON events(session_id, hook_event, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_session_time ON events(session_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_agent_id ON events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_events_overflow_sha256 ON events(overflow_sha256);
    CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id, last_seen);
    CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
  `);
  return { backfillSessionMetadata };
}

export function createSearchIndexTables(db: DatabaseSync): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS event_fts USING fts5(
      event_id UNINDEXED,
      session_id,
      cwd,
      repo_root,
      hook_event,
      content,
      content='',
      contentless_delete=1
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS session_summary_fts USING fts5(
      session_id UNINDEXED,
      cwd,
      repo_root,
      content,
      content='',
      contentless_delete=1
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS summary_node_fts USING fts5(
      node_id UNINDEXED,
      session_id,
      cwd,
      repo_root,
      depth,
      content,
      content='',
      contentless_delete=1
    );
  `);
}

function ensureColumn(db: DatabaseSync, table: string, column: string, type: string): boolean {
  const tableName = sqlIdentifier(table);
  const columnName = sqlIdentifier(column);
  const columnType = sqlColumnType(type);
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all()
    .map((row) => String(row.name));
  if (columns.includes(columnName)) return false;
  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnType}`);
  return true;
}

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value)) {
    throw new TypeError(`Invalid SQL identifier: ${value}`);
  }
  return value;
}

function sqlColumnType(value: string): string {
  if (value !== "TEXT" && value !== "INTEGER") {
    throw new TypeError(`Invalid SQL column type: ${value}`);
  }
  return value;
}
