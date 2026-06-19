import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertCliOk, runCli, tempHome } from "./helpers.ts";

test("doctor reports actionable recommendations for an unwired empty install", () => {
  const codexHome = tempHome("codex-home-");
  const lcmHome = tempHome("codex-lcm-home-");
  fs.writeFileSync(path.join(codexHome, "config.toml"), "");

  const result = runCli(["doctor", "--codex-home", codexHome, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(result);
  const report = JSON.parse(result.stdout);
  assert.equal(report.status, "warn");
  assert.equal(report.checks.some((check: { id: string; status: string }) => check.id === "plugin-wiring" && check.status === "warn"), true);
  assert.equal(report.checks.some((check: { id: string; status: string }) => check.id === "event-capture" && check.status === "warn"), true);
  assert.equal(report.recommendations.some((text: string) => text.includes("codex plugin add codex-lcm@codex-lcm")), true);
  assert.equal(report.recommendations.some((text: string) => text.includes("import-codex-sessions")), true);
});

test("import-codex-sessions dry-run counts importable records without writing storage", () => {
  const source = writeCodexSessionFixture();
  const lcmHome = tempHome("codex-lcm-import-dry-run-");

  const result = runCli(["import-codex-sessions", "--from", source, "--dry-run", "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(result);
  const report = JSON.parse(result.stdout);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.files_scanned, 1);
  assert.equal(report.records_read, 5);
  assert.equal(report.events_importable, 4);
  assert.equal(report.events_imported, 0);
  assert.equal(fs.existsSync(path.join(lcmHome, "events.jsonl")), false);
});

test("import-codex-sessions ingests existing Codex JSONL sessions idempotently", () => {
  const source = writeCodexSessionFixture();
  const lcmHome = tempHome("codex-lcm-import-");

  const first = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });
  assertCliOk(first);
  const firstReport = JSON.parse(first.stdout);
  assert.equal(firstReport.mode, "import");
  assert.equal(firstReport.events_importable, 4);
  assert.equal(firstReport.events_imported, 4);
  assert.equal(firstReport.events_skipped_duplicate, 0);

  const second = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });
  assertCliOk(second);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.events_imported, 0);
  assert.equal(secondReport.events_skipped_duplicate, 4);

  const stats = runCli(["stats", "--json"], { env: { CODEX_LCM_HOME: lcmHome } });
  assertCliOk(stats);
  const parsedStats = JSON.parse(stats.stdout);
  assert.equal(parsedStats.event_count, 4);
  assert.equal(parsedStats.session_count, 1);

  const search = runCli(["mcp"], {
    env: { CODEX_LCM_HOME: lcmHome },
    input: [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } }),
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "lcm_pack_context",
          arguments: { query: "import fixture user request", cwd: "/tmp/import-fixture", budgetTokens: 500 },
        },
      }),
      "",
    ].join("\n"),
  });
  assertCliOk(search);
  assert.match(search.stdout, /import fixture user request/u);
  assert.match(search.stdout, /import fixture assistant result/u);
});

function writeCodexSessionFixture(): string {
  const root = tempHome("codex-session-source-");
  const dir = path.join(root, "2026", "06", "18");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "rollout-2026-06-18T12-00-00-import-fixture-session.jsonl");
  const rows = [
    {
      timestamp: "2026-06-18T12:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "import-fixture-session",
        timestamp: "2026-06-18T12:00:00.000Z",
        cwd: "/tmp/import-fixture",
      },
    },
    {
      timestamp: "2026-06-18T12:00:01.000Z",
      type: "turn_context",
      payload: {
        turn_id: "turn-1",
        cwd: "/tmp/import-fixture",
      },
    },
    {
      timestamp: "2026-06-18T12:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "import fixture user request" }],
      },
    },
    {
      timestamp: "2026-06-18T12:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "import fixture assistant result" }],
      },
    },
    {
      timestamp: "2026-06-18T12:00:04.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell",
        call_id: "call-1",
        arguments: "{\"cmd\":\"date\"}",
      },
    },
  ];
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  return root;
}
