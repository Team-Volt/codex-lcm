import assert from "node:assert/strict";
import test from "node:test";

import { clearDerivedSummaries, runCli, runMcp, tempHome } from "./helpers.ts";

test("MCP server initializes and lists LCM tools", () => {
  const home = tempHome();
  const responses = runMcp([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "codex-lcm-test", version: "0.1.0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], { CODEX_LCM_HOME: home });

  assert.equal(responses[0].result.serverInfo.name, "codex-lcm");
  assert.deepEqual(
    responses[1].result.tools.map((tool: { name: string }) => tool.name),
    [
      "lcm_health",
      "lcm_stats",
      "lcm_current_session",
      "lcm_search_sessions",
      "lcm_get_session",
      "lcm_get_session_summary",
      "lcm_get_session_graph",
      "lcm_get_recent_context",
      "lcm_pack_context",
      "lcm_record_note",
    ],
  );
});

test("MCP stats reports aggregate summary depth and graph counts", () => {
  const home = tempHome();
  const cwd = "/tmp/mcp-stats";
  for (let index = 0; index < 9; index += 1) {
    const hook = runCli(["hook", "UserPromptSubmit"], {
      input: JSON.stringify({
        session_id: "mcp-stats-session",
        cwd,
        prompt: `mcp stats high signal prompt ${index}`,
      }),
      env: { CODEX_LCM_HOME: home },
    });
    assert.equal(hook.status, 0, hook.stderr);
  }

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lcm_stats", arguments: {} },
    },
  ], { CODEX_LCM_HOME: home });

  const stats = responses[1].result.structuredContent.stats;
  assert.equal(stats.event_count, 9);
  assert.equal(stats.summary_node_count, 3);
  assert.deepEqual(stats.hook_event_counts, { UserPromptSubmit: 9 });
  assert.deepEqual(stats.summary_nodes_by_depth, { "0": 2, "1": 1 });
  assert.deepEqual(stats.summary_nodes_by_source_type, { events: 2, nodes: 1 });
  assert.equal(stats.sessions_with_summary_nodes, 1);
  assert.equal(stats.max_summary_depth, 1);
  assert.equal(stats.graph_nodes_by_kind.event, 9);
  assert.equal(stats.graph_edges_by_kind.contains, 9);
});

test("MCP stats does not rebuild derived summaries", () => {
  const home = tempHome();
  const cwd = "/tmp/mcp-readonly-stats";
  for (let index = 0; index < 9; index += 1) {
    const hook = runCli(["hook", "UserPromptSubmit"], {
      input: JSON.stringify({
        session_id: "mcp-readonly-stats-session",
        cwd,
        prompt: `mcp readonly stats high signal prompt ${index}`,
      }),
      env: { CODEX_LCM_HOME: home },
    });
    assert.equal(hook.status, 0, hook.stderr);
  }
  clearDerivedSummaries(home);

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lcm_stats", arguments: {} },
    },
  ], { CODEX_LCM_HOME: home });

  const stats = responses[1].result.structuredContent.stats;
  assert.equal(stats.event_count, 9);
  assert.equal(stats.summary_count, 0);
  assert.equal(stats.summary_node_count, 0);
  assert.equal(stats.index_error, undefined);
});

test("MCP tools search and retrieve synthetic hook data", () => {
  const home = tempHome();
  const hook = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "mcp-session",
      cwd: "/tmp/mcp",
      prompt: "searchable MCP payload",
    }),
    env: { CODEX_LCM_HOME: home },
  });
  assert.equal(hook.status, 0, hook.stderr);

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_search_sessions",
        arguments: { query: "searchable", limit: 3 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "lcm_get_session",
        arguments: { sessionId: "mcp-session", limit: 20 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "lcm_get_session_summary",
        arguments: { sessionId: "mcp-session" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "lcm_get_session_graph",
        arguments: { sessionId: "mcp-session", limit: 20 },
      },
    },
  ], { CODEX_LCM_HOME: home });

  assert.equal(responses[1].result.structuredContent.matches[0].session_id, "mcp-session");
  assert.equal(responses[2].result.structuredContent.session.session_id, "mcp-session");
  assert.equal(responses[3].result.structuredContent.summary.session_id, "mcp-session");
  assert.match(responses[3].result.structuredContent.summary.title, /searchable MCP payload/u);
  assert.equal(responses[4].result.structuredContent.nodes.some((node: { kind: string }) => node.kind === "session"), true);
});

test("MCP search sessions exposes best-match metadata and current-session exclusion", () => {
  const home = tempHome();
  const cwd = "/tmp/mcp-discovery";
  assert.equal(runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "mcp-prior",
      cwd,
      prompt: "Prior summary DAG ranking source lineage implementation history.",
    }),
    env: { CODEX_LCM_HOME: home },
  }).status, 0);
  assert.equal(runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "mcp-current",
      cwd,
      prompt: "Current chat repeats summary DAG ranking source lineage search terms.",
    }),
    env: { CODEX_LCM_HOME: home },
  }).status, 0);

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_search_sessions",
        arguments: {
          cwd,
          query: "summary DAG ranking source lineage",
          limit: 5,
          excludeCurrentSession: true,
        },
      },
    },
  ], { CODEX_LCM_HOME: home });

  const matches = responses[1].result.structuredContent.matches;
  assert.deepEqual(matches.map((match: { session_id: string }) => match.session_id), ["mcp-prior"]);
  assert.equal(matches[0].best_match.kind, "summary_node");
  assert.match(matches[0].best_match.snippet, /summary DAG ranking source lineage/u);
  assert.equal(["high", "medium", "low"].includes(matches[0].discovery.confidence), true);
  assert.equal(typeof matches[0].discovery.score, "number");
});
