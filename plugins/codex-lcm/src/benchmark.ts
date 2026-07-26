import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { normalizeHookEvent } from "./events.ts";
import { createStorage } from "./storage.ts";

const BENCHMARK_SESSION_ID = "codex-lcm-benchmark-long-context";
const BENCHMARK_CWD = "/tmp/codex-lcm-benchmark";
const BENCHMARK_NEEDLE = "BENCHMARK-NEEDLE recursive evidence recovery source event";
const BENCHMARK_QUERY = "BENCHMARK-NEEDLE recursive evidence recovery";
const RETRIEVAL_BENCHMARK_CWD = "/tmp/codex-lcm-retrieval-quality";

type RetrievalCategory = "exact" | "cross-session" | "temporal" | "paraphrase";
type RetrievalSplit = "development" | "holdout";

const RETRIEVAL_BASE_CORPUS: ReadonlyArray<readonly [string, string]> = [
  ["retrieval-storage", "SQLite WAL concurrent readers were chosen for local session storage."],
  ["retrieval-websocket", "WebSocket reconnect jitter prevents synchronized client retries."],
  ["retrieval-pool", "The pool chemistry pH target is 7.4 after probe calibration."],
  ["retrieval-overflow", "Overflow payload integrity uses a content hash before bounded recovery."],
  ["retrieval-release-old", "The release signing certificate belongs to the legacy build account."],
  ["retrieval-release-new", "The release signing certificate moved to the production build account."],
  ["retrieval-migration-old", "Schema migration rollback used a manual database snapshot."],
  ["retrieval-migration-new", "Schema migration rollback now uses the automated restore job."],
  ["retrieval-backoff", "Failed requests retry with exponential delay and random spread."],
];

const RETRIEVAL_PARAPHRASE_FIXTURES: ReadonlyArray<readonly [string, string, string, RetrievalSplit]> = [
  ["retrieval-cache", "The cache removes expired entries when resident memory passes the configured ceiling.", "clear old cached data after hitting the RAM limit", "development"],
  ["retrieval-auth", "Authentication credentials rotate automatically without interrupting active sessions.", "replace login secrets without downtime", "holdout"],
  ["retrieval-queue", "Workers move poison messages to a dead-letter queue after repeated delivery failures.", "isolate jobs that keep failing", "development"],
  ["retrieval-thumbnails", "Image thumbnails are generated asynchronously after uploads complete.", "make preview pictures in the background", "holdout"],
  ["retrieval-dns", "DNS failover sends traffic to the secondary region when the primary health check fails.", "route users to a backup region during an outage", "development"],
  ["retrieval-audit", "Audit records are retained for seven years in immutable object storage.", "how long compliance history stays stored", "holdout"],
  ["retrieval-flags", "Feature flags roll out to five percent of accounts before wider activation.", "release a change gradually to a small user cohort", "development"],
  ["retrieval-rate-limit", "API rate limits use a token bucket so brief request bursts can pass.", "allow short traffic spikes while enforcing a quota", "holdout"],
  ["retrieval-backup", "Database backups run nightly and a restore drill verifies them each week.", "check that nightly snapshots can actually recover data", "development"],
  ["retrieval-email", "Email delivery retries soft bounces but stops immediately on permanent rejection.", "try temporary mail failures again without retrying hard failures", "holdout"],
  ["retrieval-encryption", "Uploaded documents use envelope encryption with a distinct wrapped data key.", "protect each file with its own wrapped key", "development"],
  ["retrieval-localization", "Missing translation keys fall back to the default English message.", "show the default language when localized text is absent", "holdout"],
  ["retrieval-pagination", "List endpoints use opaque cursor pagination to stay stable while rows change.", "page through changing results without skips", "development"],
  ["retrieval-session-expiry", "Idle browser sessions expire after thirty minutes without activity.", "sign out inactive users after half an hour", "holdout"],
  ["retrieval-readiness", "The readiness probe fails while database migrations are still pending.", "keep an instance out of traffic until database upgrades finish", "development"],
  ["retrieval-tracing", "Trace identifiers propagate through HTTP calls and queued background jobs.", "follow one request across services and queue workers", "holdout"],
  ["retrieval-scheduler", "Recurring jobs use UTC schedules to avoid daylight-saving clock changes.", "prevent seasonal clock changes from shifting scheduled work", "development"],
  ["retrieval-multipart", "Multipart uploads checksum each part before assembling the final object.", "detect damaged chunks before joining a large file", "holdout"],
  ["retrieval-indexing", "Search indexing batches document writes before refreshing visible results.", "group content updates before making search results current", "development"],
  ["retrieval-config", "The service reloads configuration on SIGHUP without restarting the process.", "apply new settings without a restart", "holdout"],
  ["retrieval-locks", "Lease-based locks renew during long jobs and expire if their worker dies.", "stop two workers owning the same task during lengthy work", "development"],
  ["retrieval-offline", "Offline edits enter an outbox and synchronize after network connectivity returns.", "sync changes made without a network after reconnecting", "holdout"],
  ["retrieval-percentile", "Metrics aggregate request latency into percentile histograms.", "measure the slowest one percent of requests", "development"],
  ["retrieval-payments", "Payment intents require an idempotency key before processing a charge.", "prevent duplicate billing when checkout retries", "holdout"],
  ["retrieval-temp-files", "Orphaned temporary files are deleted after twenty-four hours.", "remove abandoned scratch data the next day", "development"],
  ["retrieval-canary", "Canary deployments mirror one percent of production traffic to the candidate build.", "send a tiny live sample to the new version", "holdout"],
  ["retrieval-password-reset", "Password reset links expire after one use or fifteen minutes.", "make an account recovery URL single-use and short-lived", "development"],
  ["retrieval-compression", "HTTP responses use Brotli compression when the client advertises support.", "shrink browser payloads with br encoding", "holdout"],
  ["retrieval-json-schema", "Unknown JSON fields are preserved so older clients can round-trip future properties.", "keep newer properties intact when old clients save data", "development"],
  ["retrieval-connections", "The connection pool closes idle sockets before the database server timeout.", "discard unused database connections before the server does", "holdout"],
];

const RETRIEVAL_CORPUS: ReadonlyArray<readonly [string, string]> = [
  ...RETRIEVAL_BASE_CORPUS,
  ...RETRIEVAL_PARAPHRASE_FIXTURES.map(([sessionId, prompt]) => [sessionId, prompt] as const),
];

const RETRIEVAL_QUERIES: ReadonlyArray<{
  id: string;
  category: RetrievalCategory;
  split: RetrievalSplit;
  query: string;
  expectedSessionId: string;
}> = [
  { id: "exact-storage", category: "exact", split: "development", query: "SQLite WAL concurrent readers", expectedSessionId: "retrieval-storage" },
  { id: "exact-websocket", category: "exact", split: "holdout", query: "WebSocket reconnect jitter", expectedSessionId: "retrieval-websocket" },
  { id: "cross-pool", category: "cross-session", split: "development", query: "pool chemistry pH target", expectedSessionId: "retrieval-pool" },
  { id: "cross-overflow", category: "cross-session", split: "holdout", query: "overflow payload integrity hash", expectedSessionId: "retrieval-overflow" },
  { id: "temporal-release", category: "temporal", split: "development", query: "release signing certificate", expectedSessionId: "retrieval-release-new" },
  { id: "temporal-migration", category: "temporal", split: "holdout", query: "schema migration rollback", expectedSessionId: "retrieval-migration-new" },
  { id: "paraphrase-overflow", category: "paraphrase", split: "development", query: "retain oversized command output", expectedSessionId: "retrieval-overflow" },
  { id: "paraphrase-backoff", category: "paraphrase", split: "holdout", query: "randomized backoff for failed calls", expectedSessionId: "retrieval-backoff" },
  ...RETRIEVAL_PARAPHRASE_FIXTURES.map(([sessionId, _prompt, query, split], index) => ({
    id: `paraphrase-${String(index + 1).padStart(2, "0")}`,
    category: "paraphrase" as const,
    split,
    query,
    expectedSessionId: sessionId,
  })),
];

export type LongContextBenchmarkOptions = {
  events?: number;
  budgetTokens?: number;
  home?: string;
};

export type LongContextBenchmarkResult = {
  name: "long-context";
  session_id: string;
  generated_events: number;
  query: string;
  recovered: boolean;
  summary_node_count: number;
  max_summary_depth: number | null;
  packed_estimated_tokens: number;
  duration_ms: number;
  storage_home?: string;
};

export type RetrievalQualityMetrics = {
  queries: number;
  recall_at_1: number;
  recall_at_5: number;
  mean_reciprocal_rank: number;
};

export type RetrievalQualityBenchmarkResult = RetrievalQualityMetrics & {
  name: "retrieval-quality";
  corpus_version: 2;
  sessions: number;
  by_category: Record<RetrievalCategory, RetrievalQualityMetrics>;
  by_split: Record<RetrievalSplit, RetrievalQualityMetrics>;
  cases: Array<{
    id: string;
    category: RetrievalCategory;
    split: RetrievalSplit;
    query: string;
    expected_session_id: string;
    rank: number | null;
    top_session_ids: string[];
  }>;
  duration_ms: number;
  storage_home?: string;
};

export function runLongContextBenchmark(options: LongContextBenchmarkOptions = {}): LongContextBenchmarkResult {
  const eventCount = Math.max(16, Math.floor(options.events ?? 128));
  const budgetTokens = Math.max(64, Math.floor(options.budgetTokens ?? 1200));
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-benchmark-"));
  const cleanup = options.home === undefined;
  const startedAt = performance.now();
  const storage = createStorage({ home });

  try {
    const events = Array.from({ length: eventCount }, (_, index) => normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: BENCHMARK_SESSION_ID,
        cwd: BENCHMARK_CWD,
        prompt: index === 3
          ? BENCHMARK_NEEDLE
          : `benchmark filler ${index} source lineage summary retrieval ${index % 7}`,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 5, 9, 12, 0, index)),
    }));

    storage.ingestMany(events);
    const stats = storage.stats();
    const packed = storage.packContext({
      query: BENCHMARK_QUERY,
      sessionIds: [BENCHMARK_SESSION_ID],
      budgetTokens,
    });

    return {
      name: "long-context",
      session_id: BENCHMARK_SESSION_ID,
      generated_events: eventCount,
      query: BENCHMARK_QUERY,
      recovered: packed.markdown.includes(BENCHMARK_NEEDLE),
      summary_node_count: stats.summary_node_count ?? 0,
      max_summary_depth: stats.max_summary_depth,
      packed_estimated_tokens: packed.estimated_tokens,
      duration_ms: Math.round(performance.now() - startedAt),
      ...(cleanup ? {} : { storage_home: home }),
    };
  } finally {
    storage.close();
    if (cleanup) fs.rmSync(home, { recursive: true, force: true });
  }
}

export function runRetrievalQualityBenchmark(options: { home?: string } = {}): RetrievalQualityBenchmarkResult {
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-retrieval-quality-"));
  const cleanup = options.home === undefined;
  const startedAt = performance.now();
  const storage = createStorage({ home });

  try {
    storage.ingestMany(RETRIEVAL_CORPUS.map(([sessionId, prompt], index) => normalizeHookEvent({
      hookEvent: "UserPromptSubmit",
      rawInput: JSON.stringify({
        session_id: sessionId,
        cwd: RETRIEVAL_BENCHMARK_CWD,
        prompt,
      }),
      env: {},
      now: () => new Date(Date.UTC(2026, 6, 1, 12, index)),
    })));
    const cases = RETRIEVAL_QUERIES.map((entry) => {
      const topSessionIds = storage.searchSessions({
        query: entry.query,
        cwd: RETRIEVAL_BENCHMARK_CWD,
        limit: 5,
      }).map((match) => match.session_id);
      const index = topSessionIds.indexOf(entry.expectedSessionId);
      return {
        id: entry.id,
        category: entry.category,
        split: entry.split,
        query: entry.query,
        expected_session_id: entry.expectedSessionId,
        rank: index < 0 ? null : index + 1,
        top_session_ids: topSessionIds,
      };
    });
    return {
      name: "retrieval-quality",
      corpus_version: 2,
      sessions: RETRIEVAL_CORPUS.length,
      ...retrievalMetrics(cases),
      by_category: {
        exact: retrievalMetrics(cases.filter((entry) => entry.category === "exact")),
        "cross-session": retrievalMetrics(cases.filter((entry) => entry.category === "cross-session")),
        temporal: retrievalMetrics(cases.filter((entry) => entry.category === "temporal")),
        paraphrase: retrievalMetrics(cases.filter((entry) => entry.category === "paraphrase")),
      },
      by_split: {
        development: retrievalMetrics(cases.filter((entry) => entry.split === "development")),
        holdout: retrievalMetrics(cases.filter((entry) => entry.split === "holdout")),
      },
      cases,
      duration_ms: Math.round(performance.now() - startedAt),
      ...(cleanup ? {} : { storage_home: home }),
    };
  } finally {
    storage.close();
    if (cleanup) fs.rmSync(home, { recursive: true, force: true });
  }
}

function retrievalMetrics(cases: ReadonlyArray<{ rank: number | null }>): RetrievalQualityMetrics {
  const queries = cases.length;
  return {
    queries,
    recall_at_1: ratio(cases.filter((entry) => entry.rank === 1).length, queries),
    recall_at_5: ratio(cases.filter((entry) => entry.rank !== null && entry.rank <= 5).length, queries),
    mean_reciprocal_rank: ratio(cases.reduce((sum, entry) => sum + (entry.rank ? 1 / entry.rank : 0), 0), queries),
  };
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4));
}
