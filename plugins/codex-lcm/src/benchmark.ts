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

export type LongContextBenchmarkOptions = {
  events?: number;
  budgetTokens?: number;
  home?: string;
  cleanup?: boolean;
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

export function runLongContextBenchmark(options: LongContextBenchmarkOptions = {}): LongContextBenchmarkResult {
  const eventCount = Math.max(16, Math.floor(options.events ?? 128));
  const budgetTokens = Math.max(64, Math.floor(options.budgetTokens ?? 1200));
  const home = options.home ?? fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-benchmark-"));
  const cleanup = options.cleanup ?? options.home === undefined;
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
