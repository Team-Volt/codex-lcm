import assert from "node:assert/strict";
import test from "node:test";

import { runCli, runMcp, tempHome } from "./helpers.ts";

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
      "lcm_current_session",
      "lcm_search_sessions",
      "lcm_get_session",
      "lcm_get_recent_context",
      "lcm_pack_context",
      "lcm_record_note",
    ],
  );
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
        arguments: { sessionId: "mcp-session" },
      },
    },
  ], { CODEX_LCM_HOME: home });

  assert.equal(responses[1].result.structuredContent.matches[0].session_id, "mcp-session");
  assert.equal(responses[2].result.structuredContent.session.session_id, "mcp-session");
});
