import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { normalizeHookEvent } from "../src/events.ts";
import { createStorage } from "../src/storage.ts";
import { clearDerivedSummaries, runCli, runMcp, tempHome } from "./helpers.ts";

type FramedMcpResponse = {
  readonly id: unknown;
  readonly result: {
    readonly serverInfo: { readonly name: string };
    readonly tools: readonly { readonly name: string }[];
  };
  readonly error: { readonly code: number };
};

const SUPPORTED_PROTOCOL_VERSION = "2025-11-25";
const STANDARD_TOOL_NAMES = ["lcm_grep", "lcm_describe", "lcm_expand"] as const;

function seedMemorySource(home: string, sessionId: string, cwd: string): string {
  const storage = createStorage({ home });
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({ session_id: sessionId, cwd, prompt: "Source evidence for durable memory." }),
    env: {},
    now: () => new Date("2026-07-11T12:00:00.000Z"),
  });
  storage.ingest(event);
  storage.close();
  return event.event_id;
}

test("MCP server initializes and lists LCM tools", () => {
  const home = tempHome();
  const responses = runMcp([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "codex-lcm-test", version: "0.1.0" },
      },
    },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
  ], { CODEX_LCM_HOME: home });

  assert.equal(responses[0].result.protocolVersion, SUPPORTED_PROTOCOL_VERSION);
  assert.equal(responses[0].result.serverInfo.name, "codex-lcm");
  assert.match(
    responses[0].result.instructions,
    /Preferred standard workflow: lcm_grep -> lcm_describe -> lcm_expand\./u,
  );
  assert.match(responses[0].result.instructions, /mcp__codex_lcm__lcm_grep/u);
  const toolNames = responses[1].result.tools.map((tool: { name: string }) => tool.name);
  assert.deepEqual(
    toolNames,
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
      "lcm_create_memory",
      "lcm_revise_memory",
      "lcm_deprecate_memory",
      "lcm_delete_memory",
      "lcm_search_memories",
      "lcm_get_memory",
      "lcm_record_note",
    ],
  );
  for (const name of STANDARD_TOOL_NAMES) {
    assert.equal(toolNames.includes(name), true, `${name} missing from tools/list`);
  }
  const grepTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === "lcm_grep");
  assert.match(grepTool.description, /Preferred standard workflow step 1/u);
  assert.match(grepTool.description, /mcp__codex_lcm__lcm_grep/u);
  const describeTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === "lcm_describe");
  assert.match(describeTool.description, /Preferred standard workflow step 2/u);
  assert.match(describeTool.description, /mcp__codex_lcm__lcm_describe/u);
  const expandTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === "lcm_expand");
  assert.match(expandTool.description, /Preferred standard workflow step 3/u);
  assert.match(expandTool.description, /mcp__codex_lcm__lcm_expand/u);
  const expandQueryTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === "lcm_expand_query");
  assert.equal(expandQueryTool.inputSchema.properties.budgetTokens.default, 2000);
  assert.equal(expandQueryTool.inputSchema.properties.overview.type, "boolean");
  const contextPlanTool = responses[1].result.tools.find((tool: { name: string }) => tool.name === "lcm_context_plan");
  assert.equal(contextPlanTool.inputSchema.properties.canControlCompaction.const, false);
});

test("MCP hides durable memory unless enabled by environment or the LCM home .env", () => {
  const home = tempHome();
  const listRequest = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
  const callRequest = { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_search_memories", arguments: {} } };

  const disabled = runMcp([listRequest, callRequest], { CODEX_LCM_HOME: home, CODEX_LCM_MEMORY_ENABLED: "0" });
  assert.equal(disabled[0].result.tools.some((tool: { name: string }) => tool.name === "lcm_search_memories"), false);
  assert.equal(disabled[1].error.code, -32602);

  fs.writeFileSync(path.join(home, ".env"), "CODEX_LCM_MEMORY_ENABLED=1\nCODEX_LCM_MEMORY_ENABLED=0\n", "utf8");
  const duplicateDisabled = runMcp([listRequest], { CODEX_LCM_HOME: home, CODEX_LCM_MEMORY_ENABLED: undefined });
  assert.equal(duplicateDisabled[0].result.tools.some((tool: { name: string }) => tool.name === "lcm_search_memories"), false);

  fs.writeFileSync(path.join(home, ".env"), "CODEX_LCM_MEMORY_ENABLED=true\n", "utf8");
  const enabled = runMcp([listRequest], { CODEX_LCM_HOME: home, CODEX_LCM_MEMORY_ENABLED: undefined });
  assert.equal(enabled[0].result.tools.some((tool: { name: string }) => tool.name === "lcm_search_memories"), true);

  const sourceEventId = seedMemorySource(home, "disabled-memory-pack", "/tmp/disabled-memory-pack");
  runMcp([{ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lcm_create_memory", arguments: {
    sessionId: "disabled-memory-pack", cwd: "/tmp/disabled-memory-pack", text: "disabled-memory-pack-marker",
    kind: "fact", rationale: "Verify disabled packed context.", sourceEventIds: [sourceEventId],
  } } }], { CODEX_LCM_HOME: home });
  const packed = runMcp([{ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lcm_pack_context", arguments: {
    query: "disabled-memory-pack-marker", cwd: "/tmp/disabled-memory-pack",
  } } }], { CODEX_LCM_HOME: home, CODEX_LCM_MEMORY_ENABLED: "0" });
  assert.doesNotMatch(packed[0].result.structuredContent.markdown, /disabled-memory-pack-marker/u);
});

test("optional memory .env failures do not break unrelated CLI commands", () => {
  const home = tempHome();
  fs.mkdirSync(path.join(home, ".env"));

  const result = runCli(["--version"], { env: { CODEX_LCM_HOME: home, CODEX_LCM_MEMORY_ENABLED: undefined } });
  const mcp = runMcp([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }], {
    CODEX_LCM_HOME: home, CODEX_LCM_MEMORY_ENABLED: undefined,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^0\.2\.4$/mu);
  assert.equal(mcp[0].result.tools.some((tool: { name: string }) => tool.name === "lcm_search_memories"), false);
});

test("MCP creates and revises durable memories", () => {
  const home = tempHome();
  const memoryId = "44444444-4444-4444-8444-444444444444";
  const sourceEventId = seedMemorySource(home, "mcp-memory", "/tmp/mcp-memory");
  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_create_memory", arguments: { sessionId: "mcp-memory", cwd: "/tmp/mcp-memory", text: "Initial memory text.", kind: "decision", rationale: "User selected this path.", sourceEventIds: [sourceEventId], memoryId } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { sessionId: "mcp-memory", cwd: "/tmp/mcp-memory", memoryId, expectedRevision: 1, text: "Replacement memory text.", reason: "User corrected the path.", sourceEventIds: [sourceEventId] } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId, cwd: "/tmp/mcp-memory", includeContext: false } } },
  ], { CODEX_LCM_HOME: home });

  assert.equal(responses[0].result.structuredContent.memory.revision, 1);
  assert.equal(responses[1].result.structuredContent.memory.revision, 2);
  assert.equal(responses[2].result.structuredContent.memory.revisions.length, 2);
  assert.equal(responses[2].result.structuredContent.memory.memory.text, "Replacement memory text.");
});

test("MCP revision lineage inherits when omitted, clears on empty revise, and transitions cannot replace it", () => {
  const home = tempHome();
  const memoryId = "45454545-4545-4454-8454-454545454545";
  const sessionId = "mcp-memory-lineage";
  const cwd = "/tmp/mcp-memory-lineage";
  const firstSource = seedMemorySource(home, sessionId, cwd);
  const secondSource = seedMemorySource(home, sessionId, cwd);
  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_create_memory", arguments: { sessionId, cwd, text: "Lineage revision one.", kind: "decision", rationale: "Initial source.", sourceEventIds: [firstSource], memoryId } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { sessionId, cwd, memoryId, expectedRevision: 1, text: "Lineage revision two.", reason: "Inherit source." } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { sessionId, cwd, memoryId, expectedRevision: 2, text: "Lineage revision three.", reason: "Clear source.", sourceEventIds: [] } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lcm_deprecate_memory", arguments: { sessionId, cwd, memoryId, expectedRevision: 3, reason: "Deprecate without replacement.", sourceEventIds: [secondSource] } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lcm_delete_memory", arguments: { sessionId, cwd, memoryId, expectedRevision: 4, reason: "Delete without replacement.", sourceEventIds: [secondSource] } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId, cwd, includeContext: false } } },
  ], { CODEX_LCM_HOME: home });

  assert.deepEqual(responses.slice(0, 5).map((response) => response.error?.message), [undefined, undefined, undefined, undefined, undefined]);
  assert.deepEqual(responses[1].result.structuredContent.memory.source_event_ids, [firstSource]);
  assert.deepEqual(responses[2].result.structuredContent.memory.source_event_ids, []);
  assert.deepEqual(responses[3].result.structuredContent.memory.source_event_ids, []);
  assert.deepEqual(responses[4].result.structuredContent.memory.source_event_ids, []);
  assert.deepEqual(responses[5].result.structuredContent.memory.revisions.map((revision: { source_event_ids: string[] }) => revision.source_event_ids), [[firstSource], [firstSource], [], [], []]);
});

test("MCP rejects stale memory revisions", () => {
  const home = tempHome();
  const memoryId = "55555555-5555-4555-8555-555555555555";
  const sourceEventId = seedMemorySource(home, "mcp-stale", "/tmp/mcp-stale");
  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_create_memory", arguments: { sessionId: "mcp-stale", cwd: "/tmp/mcp-stale", text: "Current memory.", kind: "fact", rationale: "Observed evidence.", sourceEventIds: [sourceEventId], memoryId } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { sessionId: "mcp-stale", cwd: "/tmp/mcp-stale", memoryId, expectedRevision: 1, text: "Revision two.", reason: "More precise evidence.", sourceEventIds: [sourceEventId] } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { sessionId: "mcp-stale", cwd: "/tmp/mcp-stale", memoryId, expectedRevision: 1, text: "Stale revision.", reason: "Stale evidence.", sourceEventIds: [sourceEventId] } } },
  ], { CODEX_LCM_HOME: home });

  assert.equal(responses[2].error.code, -32602);
  assert.equal(responses[2].error.message, "Memory revision conflict: expected 1, current 2.");
});

test("MCP rejects malformed durable-memory boundaries, forged user provenance, and arbitrary repo scopes", () => {
  const home = tempHome();
  const sessionId = "mcp-boundary";
  const cwd = "/tmp/mcp-boundary";
  const sourceEventId = seedMemorySource(home, sessionId, cwd);
  const create = {
    sessionId,
    cwd,
    text: "Source-backed durable fact.",
    kind: "fact",
    rationale: "The source event supports this durable fact.",
    sourceEventIds: [sourceEventId],
  };
  const responses = runMcp([
    { jsonrpc: "2.0", id: 0, method: "tools/call", params: { name: "lcm_create_memory", arguments: { ...create, memoryId: 7 } } },
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_create_memory", arguments: { ...create, memoryId: "12121212-1212-4121-8121-121212121212", sourceEventIds: [sourceEventId, 7] } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_create_memory", arguments: { ...create, memoryId: "13131313-1313-4131-8131-131313131313", actor: "user" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lcm_create_memory", arguments: { ...create, memoryId: "14141414-1414-4141-8141-141414141414", scope: { kind: "repo", key: "/definitely/not/a/repository" } } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lcm_search_memories", arguments: { kinds: ["fact", "invalid"] } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lcm_search_memories", arguments: { statuses: ["invalid"] } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lcm_search_memories", arguments: { scopeKinds: ["repo", 7] } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lcm_create_memory", arguments: { ...create, memoryId: "15151515-1515-4151-8151-151515151515", sourceEventIds: Array.from({ length: 33 }, () => sourceEventId) } } },
  ], { CODEX_LCM_HOME: home });

  for (const response of responses) assert.equal(response.error?.code, -32602);
  assert.equal(fs.readFileSync(path.join(home, "events.jsonl"), "utf8").split("\n").filter((line) => line.includes('"hook_event":"Memory"')).length, 0);
});

test("MCP memory write schemas expose create lineage, optional clearable revise lineage, and inherited transitions", () => {
  const responses = runMcp([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }]);
  const tools = responses[0].result.tools as Array<{
    name: string;
    inputSchema: { required: string[]; properties: Record<string, { minItems?: number; maxItems?: number; maximum?: number; type?: string; items?: { enum?: string[] }; oneOf?: readonly unknown[] }> };
    annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean };
  }>;
  for (const name of ["lcm_create_memory", "lcm_revise_memory", "lcm_deprecate_memory", "lcm_delete_memory"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool, `missing ${name}`);
    assert.equal(tool.inputSchema.required.includes("sourceEventIds"), name === "lcm_create_memory");
    assert.equal(tool.inputSchema.properties.sourceEventIds?.minItems, name === "lcm_create_memory" ? 1 : name === "lcm_revise_memory" ? 0 : undefined);
    assert.equal(tool.inputSchema.properties.sourceEventIds?.maxItems, name === "lcm_create_memory" || name === "lcm_revise_memory" ? 32 : undefined);
    if ("scope" in tool.inputSchema.properties) assert.equal(tool.inputSchema.properties.scope?.oneOf?.length, 3);
    assert.equal("actor" in tool.inputSchema.properties, false);
    assert.deepEqual(tool.annotations, {
      readOnlyHint: false,
      destructiveHint: name === "lcm_delete_memory",
      idempotentHint: false,
      openWorldHint: false,
    });
  }
  const get = tools.find((candidate) => candidate.name === "lcm_get_memory");
  assert.ok(get, "missing lcm_get_memory");
  assert.equal(get.inputSchema.required.includes("cwd"), true);
  assert.equal(get.inputSchema.properties.cwd?.type, "string");
  assert.equal(get.inputSchema.properties.repoRoot?.type, "string");
  assert.equal(get.inputSchema.properties.historyLimit?.maximum, 100);
  assert.equal(get.inputSchema.properties.historyCursor?.type, "string");
  const pack = tools.find((candidate) => candidate.name === "lcm_pack_context");
  assert.ok(pack, "missing lcm_pack_context");
  assert.equal(pack.inputSchema.properties.repoRoot?.type, "string");
  const search = tools.find((candidate) => candidate.name === "lcm_search_memories");
  assert.ok(search, "missing lcm_search_memories");
  assert.deepEqual(search.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
  for (const key of ["kinds", "statuses", "scopeKinds"] as const) {
    assert.deepEqual(search.inputSchema.properties[key]?.items?.enum, key === "kinds"
      ? ["preference", "decision", "lesson", "fact", "workflow"]
      : key === "statuses"
        ? ["active", "deprecated", "deleted"]
        : ["global", "repo", "cwd"]);
  }
});

test("MCP rejects a valid foreign repository scope instead of accepting cross-repo memory poisoning", () => {
  const home = tempHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-memory-repos-"));
  const repoA = path.join(root, "repo-a");
  const repoB = path.join(root, "repo-b");
  try {
    for (const repo of [repoA, repoB]) {
      fs.mkdirSync(repo);
      assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
    }
    const sourceEventId = seedMemorySource(home, "mcp-cross-repo", repoA);
    const responses = runMcp([
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "lcm_create_memory",
          arguments: {
            sessionId: "mcp-cross-repo",
            cwd: repoA,
            text: "Foreign repo poison.",
            kind: "fact",
            rationale: "A source event exists, but only in repo A.",
            sourceEventIds: [sourceEventId],
            scope: { kind: "repo", key: repoB },
            memoryId: "23232323-2323-4232-8232-232323232323",
          },
        },
      },
    ], { CODEX_LCM_HOME: home });
    assert.equal(responses[0].error.code, -32602);
    assert.match(responses[0].error.message, /operation cwd repository root/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP rejects cross-scope durable-memory transitions without appending events", () => {
  const home = tempHome("codex-lcm-memory-transition-repos-");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-memory-transition-repos-"));
  const repoA = path.join(root, "repo-a");
  const repoB = path.join(root, "repo-b");
  try {
    for (const repo of [repoA, repoB]) {
      fs.mkdirSync(repo);
      assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
    }
    const sessionId = "mcp-transition-scope";
    const sourceEventId = seedMemorySource(home, sessionId, repoA);
    const create = (memoryId: string, text: string, scope?: { kind: "global" } | { kind: "cwd"; key: string }) => ({
      sessionId, cwd: repoA, memoryId, text, kind: "fact", rationale: "Repository A source.", sourceEventIds: [sourceEventId], ...(scope ? { scope } : {}),
    });
    const [repoRevised, repoDeprecated, repoDeleted, globalRevised, globalDeprecated, globalDeleted, cwdRevised] = [
      "45454545-4545-4545-8454-454545454545", "46464646-4646-4646-8464-464646464646", "47474747-4747-4747-8474-474747474747",
      "48484848-4848-4848-8484-484848484848", "49494949-4949-4949-8494-494949494949", "50505050-5050-4050-8050-505050505050",
      "51515151-5151-4151-8151-515151515151",
    ];
    const responses = runMcp([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_create_memory", arguments: create(repoRevised, "Repo revise.") } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_create_memory", arguments: create(repoDeprecated, "Repo deprecate.") } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lcm_create_memory", arguments: create(repoDeleted, "Repo delete.") } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lcm_create_memory", arguments: create(globalRevised, "Global revise.", { kind: "global" }) } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lcm_create_memory", arguments: create(globalDeprecated, "Global deprecate.", { kind: "global" }) } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lcm_create_memory", arguments: create(globalDeleted, "Global delete.", { kind: "global" }) } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lcm_create_memory", arguments: create(cwdRevised, "Cwd revise.", { kind: "cwd", key: repoA }) } },
      { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { memoryId: repoRevised, expectedRevision: 1, sessionId, cwd: repoB, text: "Forbidden repo revision.", reason: "Cross-repo.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "lcm_deprecate_memory", arguments: { memoryId: repoDeprecated, expectedRevision: 1, sessionId, cwd: repoB, reason: "Cross-repo.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "lcm_delete_memory", arguments: { memoryId: repoDeleted, expectedRevision: 1, sessionId, cwd: repoB, reason: "Cross-repo.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { memoryId: cwdRevised, expectedRevision: 1, sessionId, cwd: repoB, text: "Forbidden cwd revision.", reason: "Cross-cwd.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { memoryId: repoRevised, expectedRevision: 1, sessionId, cwd: repoA, text: "Allowed repo revision.", reason: "Same repo.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 13, method: "tools/call", params: { name: "lcm_deprecate_memory", arguments: { memoryId: repoDeprecated, expectedRevision: 1, sessionId, cwd: repoA, reason: "Same repo.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 14, method: "tools/call", params: { name: "lcm_delete_memory", arguments: { memoryId: repoDeleted, expectedRevision: 1, sessionId, cwd: repoA, reason: "Same repo.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 15, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { memoryId: globalRevised, expectedRevision: 1, sessionId, cwd: repoB, text: "Allowed global revision.", reason: "Global scope.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 16, method: "tools/call", params: { name: "lcm_deprecate_memory", arguments: { memoryId: globalDeprecated, expectedRevision: 1, sessionId, cwd: repoB, reason: "Global scope.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 17, method: "tools/call", params: { name: "lcm_delete_memory", arguments: { memoryId: globalDeleted, expectedRevision: 1, sessionId, cwd: repoB, reason: "Global scope.", sourceEventIds: [sourceEventId] } } },
      { jsonrpc: "2.0", id: 18, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { memoryId: cwdRevised, expectedRevision: 1, sessionId, cwd: repoA, text: "Allowed cwd revision.", reason: "Same cwd.", sourceEventIds: [sourceEventId] } } },
    ], { CODEX_LCM_HOME: home });

    for (const response of responses.slice(7, 11)) assert.equal(response.error?.code, -32602);
    assert.equal(responses[11].result.structuredContent.memory.revision, 2);
    assert.equal(responses[12].result.structuredContent.memory.status, "deprecated");
    assert.equal(responses[13].result.structuredContent.memory.status, "deleted");
    assert.equal(responses[14].result.structuredContent.memory.revision, 2);
    assert.equal(responses[15].result.structuredContent.memory.status, "deprecated");
    assert.equal(responses[16].result.structuredContent.memory.status, "deleted");
    assert.equal(responses[17].result.structuredContent.memory.revision, 2);
    assert.equal(fs.readFileSync(path.join(home, "events.jsonl"), "utf8").trim().split(/\r?\n/u).length, 15);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("MCP requires durable-memory read context and isolates repository reads", () => {
  const home = tempHome("codex-lcm-durable-cross-repo-");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-memory-read-repos-"));
  const repoA = path.join(root, "repo-a");
  const repoB = path.join(root, "repo-b");
  try {
    for (const repo of [repoA, repoB]) {
      fs.mkdirSync(repo);
      assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: repo }).status, 0);
    }
    const sessionId = "mcp-cross-repo-read";
    const sourceEventId = seedMemorySource(home, sessionId, repoA);
    const storage = createStorage({ home });
    const repoMemory = storage.createMemory({
      sessionId, cwd: repoA, text: "Repository A durable fact.", kind: "fact",
      rationale: "Repository A source.", sourceEventIds: [sourceEventId],
      memoryId: "34343434-3434-4343-8343-343434343434",
    });
    const globalMemory = storage.createMemory({
      sessionId, cwd: repoA, text: "Global durable fact.", kind: "fact",
      scope: { kind: "global" }, rationale: "Global source.", sourceEventIds: [sourceEventId],
      memoryId: "35353535-3535-4353-8353-353535353535",
    });
    storage.close();

    const eventCount = fs.readFileSync(path.join(home, "events.jsonl"), "utf8").trim().split(/\r?\n/u).length;
    const responses = runMcp([
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_search_memories", arguments: { query: "Repository A", cwd: repoA, repoRoot: repoB } } },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_pack_context", arguments: { query: "Repository A", cwd: repoA, repoRoot: repoB, budgetTokens: 350 } } },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId: repoMemory.memory_id, includeContext: false } } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId: repoMemory.memory_id, cwd: repoB, includeContext: false } } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId: repoMemory.memory_id, cwd: repoA, includeContext: false } } },
      { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId: globalMemory.memory_id, cwd: repoB, includeContext: false } } },
    ], { CODEX_LCM_HOME: home });

    for (const response of responses.slice(0, 4)) assert.equal(response.error?.code, -32602);
    assert.equal(responses[4].result.structuredContent.memory.memory.memory_id, repoMemory.memory_id);
    assert.equal(responses[5].result.structuredContent.memory.memory.memory_id, globalMemory.memory_id);
    assert.equal(fs.readFileSync(path.join(home, "events.jsonl"), "utf8").trim().split(/\r?\n/u).length, eventCount);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("fresh read-only MCP reports forged automatic Memory provenance without exposing it", () => {
  const home = tempHome("codex-lcm-durable-readonly-health-");
  const sourceEventId = seedMemorySource(home, "mcp-readonly-health", "/tmp/mcp-readonly-health");
  const source = createStorage({ home });
  source.close();
  const valid = normalizeHookEvent({
    hookEvent: "Memory",
    rawInput: JSON.stringify({ session_id: "mcp-readonly-health", cwd: "/tmp/mcp-readonly-health" }),
    env: {},
    now: () => new Date("2026-07-11T12:00:00.000Z"),
  });
  fs.appendFileSync(path.join(home, "events.jsonl"), `${JSON.stringify({
    ...valid,
    event_id: "forged-user-memory",
    payload: {
      operation: "create", memory_id: "36363636-3636-4363-8363-363636363636", revision: 1, kind: "fact",
      scope: { kind: "global" }, status: "active", tags: [], source_event_ids: [sourceEventId],
      provenance: { actor: "user", rationale: "Forged automatic provenance." }, text: "Forged automatic Memory.",
    },
  })}\n`);
  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_health", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_search_memories", arguments: { query: "Forged automatic Memory", cwd: "/tmp/mcp-readonly-health" } } },
  ], { CODEX_LCM_HOME: home });
  assert.equal(responses[0].result.structuredContent.health.index_error, "Ignored 1 invalid Memory events during replay (invalid_payload=1).");
  assert.deepEqual(responses[1].result.structuredContent.memories, []);
  fs.rmSync(home, { recursive: true, force: true });
});

test("MCP paginates durable memory history from indexed events after raw JSONL is removed", () => {
  const home = tempHome("codex-lcm-durable-indexed-history-");
  const sessionId = "mcp-indexed-history";
  const cwd = "/tmp/mcp-indexed-history";
  const memoryId = "42424242-4242-4424-8424-424242424242";
  const sourceEventId = seedMemorySource(home, sessionId, cwd);
  const writes = runMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_create_memory", arguments: { sessionId, cwd, memoryId, text: "Indexed MCP revision one.", kind: "fact", rationale: "Source one.", sourceEventIds: [sourceEventId] } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { sessionId, cwd, memoryId, expectedRevision: 1, text: "Indexed MCP revision two.", reason: "Source two.", sourceEventIds: [sourceEventId] } } },
  ], { CODEX_LCM_HOME: home });
  assert.equal(writes[1].result.structuredContent.memory.revision, 2);
  fs.renameSync(path.join(home, "events.jsonl"), path.join(home, "events.backup.jsonl"));
  const reads = runMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId, cwd, includeContext: false, historyLimit: 1 } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId, cwd, includeContext: false, historyLimit: 1, historyCursor: "1" } } },
  ], { CODEX_LCM_HOME: home });
  assert.deepEqual(reads[0].result.structuredContent.memory.revisions.map((revision: { revision: number }) => revision.revision), [2]);
  assert.equal(reads[0].result.structuredContent.memory.next_history_cursor, "1");
  assert.deepEqual(reads[1].result.structuredContent.memory.revisions.map((revision: { revision: number }) => revision.revision), [1]);
  fs.rmSync(home, { recursive: true, force: true });
});

test("MCP server falls back to its supported protocol version", () => {
  const responses = runMcp([
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    },
  ]);

  assert.equal(responses[0].result.protocolVersion, SUPPORTED_PROTOCOL_VERSION);
});

test("MCP server rejects invalid initialize params and continues", () => {
  const invalidParams: readonly unknown[] = [
    [],
    undefined,
    {},
    { protocolVersion: "" },
    { protocolVersion: 20251125 },
    { protocolVersion: SUPPORTED_PROTOCOL_VERSION, capabilities: [] },
    { protocolVersion: SUPPORTED_PROTOCOL_VERSION, capabilities: null },
    { protocolVersion: SUPPORTED_PROTOCOL_VERSION, clientInfo: [] },
    { protocolVersion: SUPPORTED_PROTOCOL_VERSION, clientInfo: null },
  ];
  const requests = invalidParams.map((params, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: "initialize",
    ...(params === undefined ? {} : { params }),
  }));
  const responses = runMcp([
    ...requests,
    { jsonrpc: "2.0", id: 99, method: "ping", params: [] },
  ]);

  assert.equal(responses.length, invalidParams.length + 1);
  for (const [index, response] of responses.slice(0, -1).entries()) {
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: index + 1,
      error: { code: -32602, message: "Invalid params" },
    });
  }
  assert.deepEqual(responses.at(-1), { jsonrpc: "2.0", id: 99, result: {} });
});

test("MCP server rejects invalid tools/call params and continues", () => {
  const home = tempHome();
  const invalidParams: readonly unknown[] = [
    [],
    undefined,
    {},
    { name: "" },
    { name: 42 },
    { name: "lcm_health", arguments: [] },
    { name: "lcm_health", arguments: null },
  ];
  const requests = invalidParams.map((params, index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: "tools/call",
    ...(params === undefined ? {} : { params }),
  }));
  const responses = runMcp([
    ...requests,
    { jsonrpc: "2.0", id: 98, method: "tools/call", params: { name: "lcm_health" } },
    { jsonrpc: "2.0", id: 99, method: "ping", params: [] },
  ], { CODEX_LCM_HOME: home });

  assert.equal(responses.length, invalidParams.length + 2);
  for (const [index, response] of responses.slice(0, invalidParams.length).entries()) {
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: index + 1,
      error: { code: -32602, message: "Invalid params" },
    });
  }
  assert.equal(responses.at(-2).result.structuredContent.health.event_count, 0);
  assert.deepEqual(responses.at(-1), { jsonrpc: "2.0", id: 99, result: {} });
});

test("MCP server stays silent for notifications with invalid method params", () => {
  const responses = runMcp([
    { jsonrpc: "2.0", method: "initialize", params: [] },
    { jsonrpc: "2.0", method: "tools/call", params: [] },
    { jsonrpc: "2.0", method: "tools/call", params: { name: "" } },
    { jsonrpc: "2.0", id: 1, method: "ping", params: [] },
  ]);

  assert.deepEqual(responses, [{ jsonrpc: "2.0", id: 1, result: {} }]);
});

test("MCP server returns invalid-request errors and continues after non-request JSON", () => {
  const invalidMessages: readonly unknown[] = [
    null,
    [],
    false,
    42,
    "not a request",
    { method: "ping" },
    { jsonrpc: "1.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", id: 2 },
  ];
  const ping = { jsonrpc: "2.0", id: 99, method: "ping" };
  const result = runCli(["mcp"], {
    input: `${[...invalidMessages, ping].map((message) => JSON.stringify(message)).join("\n")}\n`,
  });

  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
  assert.equal(responses.length, invalidMessages.length + 1);
  for (const response of responses.slice(0, -1)) {
    assert.deepEqual(response, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
  }
  assert.deepEqual(responses.at(-1), { jsonrpc: "2.0", id: 99, result: {} });
});

test("MCP server does not respond to ordinary notifications", () => {
  const responses = runMcp([
    { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
    { jsonrpc: "2.0", method: "ping" },
    { jsonrpc: "2.0", id: 1, method: "ping" },
  ]);

  assert.deepEqual(responses, [{ jsonrpc: "2.0", id: 1, result: {} }]);
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

test("MCP server frames invalid-request errors and continues for Content-Length input", () => {
  const result = runCli(["mcp"], {
    input: framedInput([
      null,
      { jsonrpc: "2.0", id: 2, method: "ping" },
    ]),
  });

  assert.equal(result.status, 0, result.stderr);
  const responses = parseFramedOutput(result.stdout);
  assert.equal(responses[0].id, null);
  assert.equal(responses[0].error.code, -32600);
  assert.equal(responses[1].id, 2);
  assert.deepEqual(responses[1].result, {});
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
