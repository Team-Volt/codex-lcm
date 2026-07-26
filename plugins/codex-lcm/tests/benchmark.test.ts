import assert from "node:assert/strict";
import test from "node:test";

import { runLongContextBenchmark, runRetrievalQualityBenchmark } from "../src/benchmark.ts";
import { assertCliOk, runCli, tempHome } from "./helpers.ts";

test("long-context benchmark recovers an old source event through packed context", () => {
  const result = runLongContextBenchmark({
    events: 64,
    budgetTokens: 800,
  });

  assert.equal(result.name, "long-context");
  assert.equal(result.generated_events, 64);
  assert.equal(result.recovered, true);
  assert.equal(result.summary_node_count > 0, true);
  assert.equal((result.max_summary_depth ?? 0) > 0, true);
  assert.equal(result.packed_estimated_tokens <= 800, true);
  assert.equal(result.duration_ms >= 0, true);
});

test("retrieval-quality benchmark reports ranked results across labeled query categories", () => {
  const result = runRetrievalQualityBenchmark();

  assert.equal(result.name, "retrieval-quality");
  assert.equal(result.corpus_version, 2);
  assert.equal(result.sessions, 39);
  assert.equal(result.queries, 38);
  assert.equal(result.cases.length, result.queries);
  assert.deepEqual(Object.keys(result.by_category).sort(), ["cross-session", "exact", "paraphrase", "temporal"]);
  assert.deepEqual(Object.keys(result.by_split).sort(), ["development", "holdout"]);
  assert.equal(result.by_category.paraphrase.queries, 32);
  assert.equal(result.by_split.development.queries, 19);
  assert.equal(result.by_split.holdout.queries, 19);
  assert.equal(result.recall_at_1 >= 0 && result.recall_at_1 <= 1, true);
  assert.equal(result.recall_at_5 >= result.recall_at_1 && result.recall_at_5 <= 1, true);
  assert.equal(result.mean_reciprocal_rank >= 0 && result.mean_reciprocal_rank <= 1, true);
  assert.equal(result.by_category.exact.recall_at_5, 1);
  assert.equal(result.by_category.paraphrase.recall_at_5 < 1, true);
  assert.equal(result.cases.every((entry) => entry.split === "development" || entry.split === "holdout"), true);
  assert.equal(result.cases.every((entry) => entry.rank === null || entry.rank > 0), true);
  assert.equal(result.duration_ms >= 0, true);
});

test("benchmark long-context command prints JSON results", () => {
  const result = runCli(["benchmark", "long-context", "--events", "64", "--budget-tokens", "800", "--json"], {
    timeout: 10_000,
  });

  assertCliOk(result);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.name, "long-context");
  assert.equal(parsed.generated_events, 64);
  assert.equal(parsed.recovered, true);
});

test("benchmark retrieval-quality command prints ranked metrics", () => {
  const result = runCli(["benchmark", "retrieval-quality", "--json"], {
    timeout: 10_000,
  });

  assertCliOk(result);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.name, "retrieval-quality");
  assert.equal(parsed.corpus_version, 2);
  assert.equal(parsed.queries, 38);
  assert.equal(parsed.cases.length, 38);
});

test("benchmark long-context command can keep caller-provided storage", () => {
  const home = tempHome("codex-lcm-benchmark-keep-");
  const result = runCli(["benchmark", "long-context", "--events", "64", "--budget-tokens", "800", "--home", home, "--json"], {
    timeout: 10_000,
  });

  assertCliOk(result);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.recovered, true);
  assert.equal(parsed.storage_home, home);
});
