import assert from "node:assert/strict";
import test from "node:test";

import { clearDerivedSummaries, runCli, runMcp, tempHome } from "./helpers.ts";

type FramedMcpResponse = {
  readonly id: unknown;
  readonly result: {
    readonly serverInfo: { readonly name: string };
    readonly tools: readonly { readonly name: string }[];
  };
  readonly error: { readonly code: number };
};

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
      "lcm_grep",
      "lcm_describe",
      "lcm_expand",
      "lcm_expand_query",
      "lcm_context_plan",
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
  const expandQueryTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === "lcm_expand_query");
  assert.equal(expandQueryTool.inputSchema.properties.budgetTokens.default, 2000);
  assert.equal(expandQueryTool.inputSchema.properties.overview.type, "boolean");
  const contextPlanTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === "lcm_context_plan");
  assert.equal(contextPlanTool.inputSchema.properties.canControlCompaction.const, false);
});

test("MCP server accepts Content-Length framed requests", () => {
  const home = tempHome();
  const result = runCli(["mcp"], {
    input: framedInput([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]),
    env: { CODEX_LCM_HOME: home },
  });

  assert.equal(result.status, 0, result.stderr);
  const responses = parseFramedOutput(result.stdout);
  assert.equal(responses[0].result.serverInfo.name, "codex-lcm");
  assert.equal(responses[1].result.tools.some((tool: { name: string }) => tool.name === "lcm_health"), true);
});

test("MCP server returns parse errors for malformed newline JSON", () => {
  const result = runCli(["mcp"], { input: "{not json\n" });

  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error.code, -32700);
});

test("MCP server returns parse errors for malformed framed JSON", () => {
  const body = "{not json";
  const result = runCli(["mcp"], { input: `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}` });

  assert.equal(result.status, 0, result.stderr);
  const responses = parseFramedOutput(result.stdout);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error.code, -32700);
});

test("MCP server rejects oversized framed bodies", () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const result = runCli(["mcp"], { input: `Content-Length: ${512 * 1024 + 1}\r\n\r\n${body}` });

  assert.equal(result.status, 0, result.stderr);
  const responses = parseFramedOutput(result.stdout);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error.code, -32700);
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
  assert.equal(stats.summary_count, 1);
  assert.equal(stats.session_summary_count, 1);
  assert.equal(stats.summary_node_count, 3);
  assert.deepEqual(stats.hook_event_counts, { UserPromptSubmit: 9 });
  assert.deepEqual(stats.summary_nodes_by_depth, { "0": 2, "1": 1 });
  assert.deepEqual(stats.summary_nodes_by_source_type, { events: 2, nodes: 1 });
  assert.equal(stats.sessions_with_session_summary, 1);
  assert.equal(stats.sessions_with_summary_nodes, 1);
  assert.equal(stats.max_summary_depth, 1);
  assert.equal(stats.graph_nodes_by_kind.event, 9);
  assert.equal(stats.graph_edges_by_kind.contains, 9);
  assert.equal(stats.graph_edges_by_kind.summary_source, 11);
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

test("MCP context plan reports token pressure for a session", () => {
  const home = tempHome();
  for (let index = 0; index < 12; index += 1) {
    const hook = runCli(["hook", "UserPromptSubmit"], {
      input: JSON.stringify({
        session_id: "mcp-context-plan-session",
        cwd: "/tmp/mcp-context-plan",
        prompt: `mcp context budget pressure ${index} ${"signal ".repeat(40)}`,
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
      params: {
        name: "lcm_context_plan",
        arguments: {
          sessionId: "mcp-context-plan-session",
          modelContextWindow: 2_000,
          autoCompactTokenLimit: 200,
        },
      },
    },
  ], { CODEX_LCM_HOME: home });

  const plan = responses[1].result.structuredContent.plan;
  assert.equal(plan.session_id, "mcp-context-plan-session");
  assert.equal(plan.state, "over_limit");
  assert.equal(plan.can_control_compaction, false);
  assert.equal(responses[1].result.content[0].text.includes("over_limit"), true);
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

test("MCP standard LCM verbs grep, describe, and expand summary-node evidence", () => {
  const home = tempHome();
  const cwd = "/tmp/mcp-standard-verbs";
  for (let index = 0; index < 9; index += 1) {
    const hook = runCli(["hook", "UserPromptSubmit"], {
      input: JSON.stringify({
        session_id: "mcp-standard-verbs-session",
        cwd,
        prompt: `canonical alias evidence prompt ${index}`,
      }),
      env: { CODEX_LCM_HOME: home },
    });
    assert.equal(hook.status, 0, hook.stderr);
  }

  const discoveryResponses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_grep",
        arguments: { query: "canonical alias evidence", cwd, limit: 3 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "lcm_describe",
        arguments: { sessionId: "mcp-standard-verbs-session", limit: 20 },
      },
    },
  ], { CODEX_LCM_HOME: home });

  const matches = discoveryResponses[1].result.structuredContent.matches;
  assert.equal(matches[0].session_id, "mcp-standard-verbs-session");
  assert.equal(matches[0].best_match.kind, "summary_node");

  const description = discoveryResponses[2].result.structuredContent.description;
  assert.equal(description.target, "session");
  assert.equal(description.session.session_id, "mcp-standard-verbs-session");
  assert.equal(description.summary.session_id, "mcp-standard-verbs-session");
  assert.equal(description.summary_nodes.length > 0, true);

  const nodeId = description.summary_nodes.find((node: { depth: number }) => node.depth === 0)?.node_id ??
    description.summary_nodes[0].node_id;

  const expansionResponses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_expand",
        arguments: { nodeId, query: "canonical alias evidence", limit: 4 },
      },
    },
  ], { CODEX_LCM_HOME: home });

  const expansion = expansionResponses[1].result.structuredContent.expansion;
  assert.equal(expansion.target, "summary_node");
  assert.equal(expansion.node.node_id, nodeId);
  assert.equal(expansion.source_events.length > 0, true);
  assert.match(expansion.markdown, /canonical alias evidence/u);
});

test("MCP describe inspects large file references without loading content", () => {
  const home = tempHome();
  const cwd = "/tmp/mcp-file-ref";
  const content = JSON.stringify({
    rows: Array.from({ length: 800 }, (_, index) => ({ id: index, label: `mcp file row ${index}` })),
  });
  assert.equal(runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "mcp-file-ref-session",
      cwd,
      tool_name: "Read",
      tool_response: {
        file_path: "/tmp/mcp-file-ref/data.json",
        content,
      },
    }),
    env: { CODEX_LCM_HOME: home },
  }).status, 0);

  const descriptionResponses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_describe",
        arguments: { sessionId: "mcp-file-ref-session", limit: 10 },
      },
    },
  ], { CODEX_LCM_HOME: home });

  const fileRefs = descriptionResponses[1].result.structuredContent.description.file_refs;
  assert.equal(fileRefs.length, 1);
  assert.equal(fileRefs[0].path, "/tmp/mcp-file-ref/data.json");
  assert.match(fileRefs[0].exploration_summary, /JSON object/u);
  assert.equal("content" in fileRefs[0], false);

  const fileResponses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_describe",
        arguments: { fileId: fileRefs[0].file_ref_id },
      },
    },
  ], { CODEX_LCM_HOME: home });

  const fileDescription = fileResponses[1].result.structuredContent.description;
  assert.equal(fileDescription.target, "file_ref");
  assert.equal(fileDescription.file_ref.file_ref_id, fileRefs[0].file_ref_id);
  assert.equal(fileDescription.file_ref.byte_count, Buffer.byteLength(content, "utf8"));
  assert.match(fileDescription.file_ref.exploration_summary, /rows/u);
});

test("MCP expand_query returns recursive evidence for a focused query", () => {
  const home = tempHome();
  const cwd = "/tmp/mcp-expand-query";
  for (let index = 0; index < 40; index += 1) {
    const hook = runCli(["hook", "UserPromptSubmit"], {
      input: JSON.stringify({
        session_id: "mcp-expand-query-session",
        cwd,
        prompt: index === 3
          ? "mcp-expand-query-needle source lineage decision"
          : `mcp expand query filler ${index}`,
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
      params: {
        name: "lcm_expand_query",
        arguments: {
          query: "mcp-expand-query-needle source lineage",
          cwd,
          budgetTokens: 500,
          limit: 2,
          sourceLimit: 4,
        },
      },
    },
  ], { CODEX_LCM_HOME: home });

  const expansion = responses[1].result.structuredContent.expansion;
  assert.equal(expansion.query, "mcp-expand-query-needle source lineage");
  assert.match(expansion.markdown, /mcp-expand-query-needle source lineage decision/u);
  assert.equal(expansion.estimated_tokens <= 500, true);
  assert.equal(expansion.sources.some((source: { kind: string; node_id?: string }) => source.kind === "summary" && source.node_id), true);
  assert.equal(expansion.sources.some((source: { kind: string; event_id?: string }) => source.kind === "event" && source.event_id), true);
  assert.equal(typeof expansion.truncated, "boolean");
});

test("MCP pack context biases toward the active thread across cwd mismatches", () => {
  const home = tempHome();
  const targetSessionId = "mcp-warp-active-thread";
  const targetThreadId = "mcp-warp-active-agent";
  const targetCwd = "/tmp/home";
  const requestedCwd = "/tmp/projects/warp";
  const query = "active-thread-needle";

  assert.equal(runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: targetSessionId,
      turn_id: "target-turn",
      agent_id: targetThreadId,
      cwd: targetCwd,
      prompt: "active-thread-needle: Warp issue 12890 PR 12891 implements file path links setting. Commented on spec PR 12977 that the spec matches intent.",
    }),
    env: { CODEX_LCM_HOME: home },
  }).status, 0);
  assert.equal(runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "mcp-warp-adjacent-hello",
      cwd: requestedCwd,
      prompt: "active-thread-needle hello",
    }),
    env: { CODEX_LCM_HOME: home },
  }).status, 0);

  const withoutThread = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_pack_context",
        arguments: {
          query,
          cwd: requestedCwd,
          budgetTokens: 700,
        },
      },
    },
  ], { CODEX_LCM_HOME: home });
  assert.doesNotMatch(
    withoutThread[1].result.structuredContent.markdown,
    /Commented on spec PR 12977 that the spec matches intent/u,
  );

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_pack_context",
        arguments: {
          query,
          cwd: requestedCwd,
          budgetTokens: 700,
        },
      },
    },
  ], { CODEX_LCM_HOME: home, CODEX_THREAD_ID: targetThreadId });

  const packed = responses[1].result.structuredContent;
  assert.match(packed.markdown, /Commented on spec PR 12977 that the spec matches intent/u);
  assert.equal(
    packed.sources.some((source: { session_id: string }) => source.session_id === targetSessionId),
    true,
  );
});

test("MCP describe reports missing sessions instead of fabricating descriptions", () => {
  const home = tempHome();
  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_describe",
        arguments: { sessionId: "missing-session" },
      },
    },
  ], { CODEX_LCM_HOME: home });

  assert.equal(responses[1].error.code, -32602);
  assert.match(responses[1].error.message, /Session not found: missing-session/u);
});

function framedInput(messages: unknown[]): string {
  return messages.map((message) => {
    const body = JSON.stringify(message);
    return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
  }).join("");
}

function parseFramedOutput(output: string): FramedMcpResponse[] {
  const responses: FramedMcpResponse[] = [];
  let buffer = Buffer.from(output, "utf8");
  while (buffer.length > 0) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    assert.notEqual(headerEnd, -1, output);
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const lengthMatch = /^Content-Length: (\d+)$/imu.exec(header);
    assert.ok(lengthMatch, header);
    const length = Number(lengthMatch[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    assert.equal(buffer.length >= bodyEnd, true, output);
    responses.push(JSON.parse(buffer.subarray(bodyStart, bodyEnd).toString("utf8")));
    buffer = buffer.subarray(bodyEnd);
  }
  return responses;
}
