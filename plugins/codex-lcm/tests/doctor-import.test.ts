import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { importCodexSessions } from "../src/codex-import.ts";
import { normalizeHookEvent } from "../src/events.ts";
import { createStorage } from "../src/storage.ts";
import { assertCliOk, runCli, runMcp, tempHome } from "./helpers.ts";

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

  const first = runCli(["import-codex-sessions", "--from", source, "--batch-size", "1", "--json"], {
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

test("import-codex-sessions progress writes to stderr without corrupting JSON stdout", () => {
  const source = writeCodexSessionFixture();
  const lcmHome = tempHome("codex-lcm-import-progress-");

  const result = runCli(["import-codex-sessions", "--from", source, "--progress", "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(result);
  const report = JSON.parse(result.stdout);
  assert.equal(report.events_imported, 4);
  assert.match(result.stderr, /codex-lcm import:/u);
  assert.match(result.stderr, /imported=4/u);
});

test("import-codex-sessions exposes child lineage, runtime metadata, usage, and time-filtered listing", () => {
  const sourceDir = tempHome("codex-lcm-lineage-source-");
  const source = path.join(sourceDir, "rollout-2026-07-14T10-00-00-child-session.jsonl");
  const rows = [
    {
      timestamp: "2026-07-14T14:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "child-session",
        cwd: "/tmp/lineage",
        agent_role: "worker",
        agent_nickname: "Child Worker",
        parent_thread_id: "parent-session",
        source: { subagent: { thread_spawn: { parent_thread_id: "parent-session", depth: 1 } } },
      },
    },
    {
      timestamp: "2026-07-14T14:00:01.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-1", cwd: "/tmp/lineage", model: "gpt-5.6-sol", effort: "high" },
    },
    {
      timestamp: "2026-07-14T14:00:02.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 100,
            cached_input_tokens: 40,
            output_tokens: 20,
            reasoning_output_tokens: 5,
            total_tokens: 120,
          },
          model_context_window: 258400,
        },
      },
    },
  ];
  fs.writeFileSync(source, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const home = tempHome("codex-lcm-lineage-home-");

  const imported = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: home },
  });
  assertCliOk(imported);
  assert.equal(JSON.parse(imported.stdout).events_imported, 3);

  const listed = runCli([
    "sessions",
    "--since", "2026-07-14T13:59:00.000Z",
    "--until", "2026-07-14T14:01:00.000Z",
    "--parent-session-id", "parent-session",
    "--json",
  ], { env: { CODEX_LCM_HOME: home } });
  assertCliOk(listed);
  const page = JSON.parse(listed.stdout);
  assert.equal(page.sessions.length, 1);
  assert.deepEqual(page.sessions[0], {
    session_id: "child-session",
    first_seen: "2026-07-14T14:00:00.000Z",
    last_seen: "2026-07-14T14:00:02.000Z",
    cwd: "/tmp/lineage",
    event_count: 3,
    parent_session_id: "parent-session",
    agent_role: "worker",
    agent_nickname: "Child Worker",
    model: "gpt-5.6-sol",
    reasoning_effort: "high",
    total_input_tokens: 100,
    cached_input_tokens: 40,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 120,
  });

  const usage = runCli(["usage", "--since", "2026-07-14T13:59:00.000Z", "--json"], {
    env: { CODEX_LCM_HOME: home },
  });
  assertCliOk(usage);
  assert.deepEqual(JSON.parse(usage.stdout).totals, {
    sessions: 1,
    input_tokens: 100,
    cached_input_tokens: 40,
    output_tokens: 20,
    reasoning_output_tokens: 5,
    total_tokens: 120,
  });

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lcm_list_sessions", arguments: { since: "2026-07-14T13:59:00.000Z", parentSessionId: "parent-session" } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "lcm_usage", arguments: { since: "2026-07-14T13:59:00.000Z" } },
    },
  ], { CODEX_LCM_HOME: home });
  assert.equal(responses[1].result.structuredContent.page.sessions[0].parent_session_id, "parent-session");
  assert.equal(responses[2].result.structuredContent.usage.totals.total_tokens, 120);
});

test("metadata backfill does not duplicate events imported by an older version", () => {
  const sourceDir = tempHome("codex-lcm-upgrade-source-");
  const source = path.join(sourceDir, "rollout-upgrade-session.jsonl");
  const sessionMeta = {
    id: "upgrade-session",
    cwd: "/tmp/upgrade",
    agent_role: "worker",
    parent_thread_id: "parent-session",
  };
  const rows = [
    { timestamp: "2026-07-14T15:00:00.000Z", type: "session_meta", payload: sessionMeta },
    {
      timestamp: "2026-07-14T15:00:01.000Z",
      type: "turn_context",
      payload: { turn_id: "turn-1", cwd: "/tmp/upgrade", model: "gpt-5.6-sol", effort: "high" },
    },
    {
      timestamp: "2026-07-14T15:00:02.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "upgrade compatibility prompt" },
    },
    {
      timestamp: "2026-07-14T15:00:03.000Z",
      type: "event_msg",
      payload: { type: "token_count", info: { total_token_usage: { input_tokens: 10, total_tokens: 10 } } },
    },
  ];
  fs.writeFileSync(source, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const home = tempHome("codex-lcm-upgrade-home-");
  const storage = createStorage({ home });
  storage.ingest(normalizeHookEvent({
    hookEvent: "SessionStart",
    rawInput: JSON.stringify({
      session_id: "upgrade-session",
      cwd: "/tmp/upgrade",
      imported_from: source,
      codex_record_type: "session_meta",
      source_timestamp: rows[0].timestamp,
      metadata: sessionMeta,
    }),
    env: {},
    now: () => new Date(rows[0].timestamp),
  }));
  storage.ingest(normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      prompt: "upgrade compatibility prompt",
      imported_from: source,
      codex_record_type: "event_msg",
      source_timestamp: rows[2].timestamp,
      turn_id: "turn-1",
      session_id: "upgrade-session",
      cwd: "/tmp/upgrade",
    }),
    env: {},
    now: () => new Date(rows[2].timestamp),
  }));
  storage.close();

  const result = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: home },
  });
  assertCliOk(result);
  const report = JSON.parse(result.stdout);
  assert.equal(report.events_imported, 2);
  assert.equal(report.events_skipped_duplicate, 2);

  const listed = runCli(["sessions", "--json"], { env: { CODEX_LCM_HOME: home } });
  assertCliOk(listed);
  const [session] = JSON.parse(listed.stdout).sessions;
  assert.equal(session.event_count, 4);
  assert.equal(session.parent_session_id, "parent-session");
  assert.equal(session.agent_role, "worker");
  assert.equal(session.model, "gpt-5.6-sol");
  assert.equal(session.reasoning_effort, "high");
  assert.equal(session.total_tokens, 10);
});

test("import-codex-sessions recalls standalone event messages and re-imports them idempotently", () => {
  const source = writeStandaloneEventMessageFixture();
  const lcmHome = tempHome("codex-lcm-import-event-messages-");

  const first = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(first);
  const firstReport = JSON.parse(first.stdout);
  assert.equal(firstReport.records_read, 5);
  assert.equal(firstReport.events_importable, 3);
  assert.equal(firstReport.events_imported, 3);
  assert.equal(firstReport.records_skipped, 2);

  const second = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(second);
  const secondReport = JSON.parse(second.stdout);
  assert.equal(secondReport.events_imported, 0);
  assert.equal(secondReport.events_skipped_duplicate, 3);

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lcm_search_sessions", arguments: { query: "standalone_event_user_needle" } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "lcm_search_sessions", arguments: { query: "standalone_event_assistant_needle" } },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "lcm_get_session", arguments: { sessionId: "standalone-event-message-session" } },
    },
  ], { CODEX_LCM_HOME: lcmHome });
  assert.match(JSON.stringify(responses[1]), /standalone-event-message-session/u);
  assert.match(JSON.stringify(responses[2]), /standalone-event-message-session/u);
  const session = JSON.stringify(responses[3]);
  assert.match(session, /"hook_event":"UserPromptSubmit"/u);
  assert.match(session, /"hook_event":"Stop"/u);
  assert.match(session, /standalone_event_user_needle/u);
  assert.match(session, /standalone_event_assistant_needle/u);
  assert.doesNotMatch(session, /synthetic_event_(?:user|assistant)_needle/u);
});

test("import-codex-sessions imports current response items and deduplicates exact event message pairs", () => {
  const source = writeCurrentCodexSessionFixture();
  const lcmHome = tempHome("codex-lcm-import-current-");

  const result = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(result);
  const report = JSON.parse(result.stdout);
  assert.equal(report.records_read, 10);
  assert.equal(report.events_importable, 7);
  assert.equal(report.events_imported, 7);
  assert.equal(report.records_skipped, 3);

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lcm_search_sessions", arguments: { query: "current_shape_tool_needle" } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "lcm_search_sessions", arguments: { query: "current fixture user request" } },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "lcm_search_sessions", arguments: { query: "compacted_context_needle" } },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "lcm_get_session", arguments: { sessionId: "import-current-session" } },
    },
  ], { CODEX_LCM_HOME: lcmHome });
  assert.match(JSON.stringify(responses[1]), /import-current-session/u);
  assert.match(JSON.stringify(responses[2]), /import-current-session/u);
  assert.match(JSON.stringify(responses[3]), /import-current-session/u);
  const session = JSON.stringify(responses[4]);
  assert.match(session, /"hook_event":"PostCompact"/u);
  assert.match(session, /agent message needle/u);
  assert.match(session, /current tool output needle/u);
  assert.match(session, /web search action needle/u);
  assert.equal(session.match(/"hook_event":"UserPromptSubmit"/gu)?.length ?? 0, 1);
  assert.equal(session.match(/"hook_event":"Stop"/gu)?.length ?? 0, 1);
});

test("import-codex-sessions deduplicates exact event message pairs when event_msg appears first", () => {
  const source = writeReversedEventMessagePairFixture();
  const lcmHome = tempHome("codex-lcm-import-reversed-event-messages-");

  const result = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(result);
  const report = JSON.parse(result.stdout);
  assert.equal(report.records_read, 6);
  assert.equal(report.events_importable, 3);
  assert.equal(report.events_imported, 3);
  assert.equal(report.records_skipped, 3);

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lcm_get_session", arguments: { sessionId: "reversed-event-message-session" } },
    },
  ], { CODEX_LCM_HOME: lcmHome });
  const session = JSON.stringify(responses[1]);
  assert.equal(session.match(/"hook_event":"UserPromptSubmit"/gu)?.length ?? 0, 1);
  assert.equal(session.match(/"hook_event":"Stop"/gu)?.length ?? 0, 1);
  assert.equal(session.match(/"codex_record_type":"event_msg"/gu)?.length ?? 0, 2);
  assert.doesNotMatch(session, /"codex_record_type":"response_item"/u);
});

test("import-codex-sessions preserves whitespace-distinct cross-shape and repeated same-shape messages", () => {
  const source = writeWhitespaceDistinctMessageFixture();
  const lcmHome = tempHome("codex-lcm-import-whitespace-distinct-");

  const result = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(result);
  const report = JSON.parse(result.stdout);
  assert.equal(report.records_read, 10);
  assert.equal(report.events_importable, 9);
  assert.equal(report.events_imported, 9);
  assert.equal(report.records_skipped, 1);

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lcm_search_sessions", arguments: { query: "whitespace_distinct_user_needle" } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "lcm_search_sessions", arguments: { query: "whitespace_distinct_assistant_needle" } },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "lcm_get_session", arguments: { sessionId: "whitespace-distinct-message-session" } },
    },
  ], { CODEX_LCM_HOME: lcmHome });
  assert.match(JSON.stringify(responses[1]), /whitespace-distinct-message-session/u);
  assert.match(JSON.stringify(responses[2]), /whitespace-distinct-message-session/u);
  const session = JSON.stringify(responses[3]);
  assert.equal(session.match(/"hook_event":"UserPromptSubmit"/gu)?.length ?? 0, 4);
  assert.equal(session.match(/"hook_event":"Stop"/gu)?.length ?? 0, 4);
  assert.equal(session.match(/"codex_record_type":"event_msg"/gu)?.length ?? 0, 4);
  assert.equal(session.match(/"codex_record_type":"response_item"/gu)?.length ?? 0, 4);
  assert.equal(session.match(/"prompt":"whitespace_distinct_user_needle"/gu)?.length ?? 0, 2);
  assert.equal(session.match(/"last_assistant_message":"whitespace_distinct_assistant_needle"/gu)?.length ?? 0, 2);
});

test("import-codex-sessions skips an invalid timestamp and imports later records and files", () => {
  const source = writeInvalidTimestampFixture();
  const lcmHome = tempHome("codex-lcm-import-invalid-timestamp-");

  const result = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(result);
  const report = JSON.parse(result.stdout);
  assert.equal(report.files_scanned, 2);
  assert.equal(report.records_read, 5);
  assert.equal(report.events_imported, 4);
  assert.equal(report.records_skipped, 1);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].line, 2);
  assert.match(report.errors[0].message, /Invalid time value|invalid timestamp/iu);

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lcm_search_sessions", arguments: { query: "valid_after_bad_timestamp_needle" } },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "lcm_search_sessions", arguments: { query: "valid_later_file_needle" } },
    },
  ], { CODEX_LCM_HOME: lcmHome });
  assert.match(JSON.stringify(responses[1]), /invalid-timestamp-session/u);
  assert.match(JSON.stringify(responses[2]), /later-file-session/u);
});

test("import-codex-sessions reports an unreadable file and continues with the next file", (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) {
    t.skip("requires POSIX file permissions for a non-root user");
    return;
  }
  const source = tempHome("codex-session-unreadable-");
  const unreadable = path.join(source, "a-unreadable.jsonl");
  fs.writeFileSync(unreadable, "{}\n", { mode: 0o000 });
  writeRows(path.join(source, "b-valid.jsonl"), [
    sessionMeta("read-error-session", "2026-06-18T14:00:00.000Z"),
    userMessage("valid_after_read_error_needle", "2026-06-18T14:00:01.000Z"),
  ]);
  const lcmHome = tempHome("codex-lcm-import-read-error-");
  t.after(() => fs.chmodSync(unreadable, 0o600));

  const result = runCli(["import-codex-sessions", "--from", source, "--json"], {
    env: { CODEX_LCM_HOME: lcmHome },
  });

  assertCliOk(result);
  const report = JSON.parse(result.stdout);
  assert.equal(report.files_scanned, 2);
  assert.equal(report.events_imported, 2);
  assert.equal(report.records_skipped, 1);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].file, unreadable);
  assert.equal(report.errors[0].line, undefined);
});

test("import-codex-sessions propagates storage failures instead of reporting skipped input", async (t) => {
  const source = tempHome("codex-session-storage-error-");
  writeRows(path.join(source, "session.jsonl"), [
    sessionMeta("storage-error-session", "2026-06-18T15:00:00.000Z"),
  ]);
  const storage = createStorage({ home: tempHome("codex-lcm-import-storage-error-") });
  t.after(() => storage.close());
  t.mock.method(storage, "ingestMany", () => {
    throw new Error("synthetic storage failure");
  });

  await assert.rejects(importCodexSessions(storage, { from: source, batchSize: 1 }), /synthetic storage failure/u);
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

function writeCurrentCodexSessionFixture(): string {
  const root = tempHome("codex-session-current-");
  const file = path.join(root, "current.jsonl");
  writeRows(file, [
    sessionMeta("import-current-session", "2026-06-18T12:00:00.000Z"),
    { timestamp: "2026-06-18T12:00:01.000Z", type: "turn_context", payload: { turn_id: "turn-current", cwd: "/tmp/import-fixture" } },
    userMessage("current fixture user request", "2026-06-18T12:00:02.000Z"),
    { timestamp: "2026-06-18T12:00:02.003Z", type: "event_msg", payload: { type: "user_message", message: "current fixture user request" } },
    { timestamp: "2026-06-18T12:00:03.000Z", type: "response_item", payload: { type: "agent_message", author: "/root/worker", recipient: "/root", content: [{ type: "input_text", text: "agent message needle" }] } },
    { timestamp: "2026-06-18T12:00:03.004Z", type: "event_msg", payload: { type: "agent_message", message: "agent message needle" } },
    { timestamp: "2026-06-18T12:00:04.000Z", type: "response_item", payload: { type: "custom_tool_call", name: "current_shape_tool_needle", call_id: "custom-1", input: "{\"query\":\"current tool input needle\"}" } },
    { timestamp: "2026-06-18T12:00:05.000Z", type: "response_item", payload: { type: "custom_tool_call_output", call_id: "custom-1", output: "current tool output needle" } },
    { timestamp: "2026-06-18T12:00:06.000Z", type: "response_item", payload: { type: "web_search_call", id: "web-1", status: "completed", action: { type: "search", query: "web search action needle" } } },
    { timestamp: "2026-06-18T12:00:07.000Z", type: "compacted", payload: { message: "compacted_context_needle preserves the prior decision", replacement_history: [] } },
  ]);
  return root;
}

function writeStandaloneEventMessageFixture(): string {
  const root = tempHome("codex-session-standalone-event-messages-");
  writeRows(path.join(root, "standalone.jsonl"), [
    sessionMeta("standalone-event-message-session", "2026-06-18T12:30:00.000Z"),
    eventMessage("user_message", "standalone_event_user_needle", "2026-06-18T12:30:01.000Z"),
    eventMessage("agent_message", "standalone_event_assistant_needle", "2026-06-18T12:30:02.000Z"),
    eventMessage("user_message", "<environment_context>synthetic_event_user_needle", "2026-06-18T12:30:03.000Z"),
    eventMessage("agent_message", "<developer>synthetic_event_assistant_needle", "2026-06-18T12:30:04.000Z"),
  ]);
  return root;
}

function writeReversedEventMessagePairFixture(): string {
  const root = tempHome("codex-session-reversed-event-messages-");
  writeRows(path.join(root, "reversed.jsonl"), [
    sessionMeta("reversed-event-message-session", "2026-06-18T12:45:00.000Z"),
    { timestamp: "2026-06-18T12:45:01.000Z", type: "turn_context", payload: { turn_id: "turn-reversed", cwd: "/tmp/import-fixture" } },
    eventMessage("user_message", "reversed_event_user_needle", "2026-06-18T12:45:02.000Z"),
    userMessage("reversed_event_user_needle", "2026-06-18T12:45:02.004Z"),
    eventMessage("agent_message", "reversed_event_assistant_needle", "2026-06-18T12:45:03.000Z"),
    agentMessage("reversed_event_assistant_needle", "2026-06-18T12:45:03.004Z"),
  ]);
  return root;
}

function writeWhitespaceDistinctMessageFixture(): string {
  const root = tempHome("codex-session-whitespace-distinct-");
  writeRows(path.join(root, "whitespace-distinct.jsonl"), [
    sessionMeta("whitespace-distinct-message-session", "2026-06-18T12:50:00.000Z"),
    { timestamp: "2026-06-18T12:50:01.000Z", type: "turn_context", payload: { turn_id: "turn-whitespace-distinct", cwd: "/tmp/import-fixture" } },
    userMessage("whitespace_distinct_user_needle ", "2026-06-18T12:50:02.000Z"),
    eventMessage("user_message", "whitespace_distinct_user_needle", "2026-06-18T12:50:02.004Z"),
    eventMessage("agent_message", "whitespace_distinct_assistant_needle ", "2026-06-18T12:50:03.000Z"),
    agentMessage("whitespace_distinct_assistant_needle", "2026-06-18T12:50:03.004Z"),
    userMessage("repeated_same_shape_user_needle", "2026-06-18T12:50:04.000Z"),
    userMessage("repeated_same_shape_user_needle", "2026-06-18T12:50:04.004Z"),
    eventMessage("agent_message", "repeated_same_shape_assistant_needle", "2026-06-18T12:50:05.000Z"),
    eventMessage("agent_message", "repeated_same_shape_assistant_needle", "2026-06-18T12:50:05.004Z"),
  ]);
  return root;
}

function writeInvalidTimestampFixture(): string {
  const root = tempHome("codex-session-invalid-timestamp-");
  writeRows(path.join(root, "a-invalid.jsonl"), [
    sessionMeta("invalid-timestamp-session", "2026-06-18T13:00:00.000Z"),
    userMessage("invalid timestamp record", "not-a-timestamp"),
    userMessage("valid_after_bad_timestamp_needle", "2026-06-18T13:00:02.000Z"),
  ]);
  writeRows(path.join(root, "b-valid.jsonl"), [
    sessionMeta("later-file-session", "2026-06-18T13:01:00.000Z"),
    userMessage("valid_later_file_needle", "2026-06-18T13:01:01.000Z"),
  ]);
  return root;
}

function sessionMeta(id: string, timestamp: string): Record<string, unknown> {
  return { timestamp, type: "session_meta", payload: { id, cwd: "/tmp/import-fixture" } };
}

function userMessage(text: string, timestamp: string): Record<string, unknown> {
  return { timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } };
}

function agentMessage(text: string, timestamp: string): Record<string, unknown> {
  return { timestamp, type: "response_item", payload: { type: "agent_message", content: [{ type: "output_text", text }] } };
}

function eventMessage(type: "user_message" | "agent_message", message: string, timestamp: string): Record<string, unknown> {
  return { timestamp, type: "event_msg", payload: { type, message } };
}

function writeRows(file: string, rows: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}
