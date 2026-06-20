import assert from "node:assert/strict";
import test from "node:test";

import { runLongContextBenchmark } from "../src/benchmark.ts";
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
