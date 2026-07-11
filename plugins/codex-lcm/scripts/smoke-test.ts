import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-memory-qa-"));

try {
  runHook("SessionStart", {
    session_id: "smoke-session",
    cwd: root,
    message: "smoke session start",
  });
  runHook("UserPromptSubmit", {
    session_id: "smoke-session",
    cwd: root,
    prompt: "smoke searchable context with sk-proj-secret-value",
  });
  runHook("PreToolUse", {
    session_id: "smoke-session",
    cwd: root,
    tool_name: "mcp__codex_lcm__lcm_pack_context",
    tool_input: { query: "smoke searchable context", budgetTokens: 120 },
    tool_use_id: "smoke-lcm-self-reference",
  });
  runHook("Stop", {
    session_id: "smoke-session",
    cwd: root,
    last_assistant_message: "Smoke verified extractive summaries and packed context.",
  });
  for (let index = 0; index < 20; index += 1) {
    runHook("UserPromptSubmit", {
      session_id: "smoke-long-session",
      turn_id: `smoke-turn-${index}`,
      cwd: root,
      prompt: index === 2 ? "smoke-old-dag-marker should survive long-session packing" : `smoke filler ${index}`,
    });
  }

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_health",
        arguments: {},
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "lcm_search_sessions",
        arguments: { query: "searchable", limit: 5 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "lcm_pack_context",
        arguments: { query: "searchable", budgetTokens: 120 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "lcm_get_session_summary",
        arguments: { sessionId: "smoke-session" },
      },
    },
    {
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "lcm_get_session_graph",
        arguments: { sessionId: "smoke-session", limit: 20 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: {
        name: "lcm_pack_context",
        arguments: { query: "smoke-old-dag-marker", budgetTokens: 160 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "lcm_grep",
        arguments: { query: "smoke searchable context", limit: 5 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "lcm_describe",
        arguments: { sessionId: "smoke-session", limit: 20 },
      },
    },
  ]);

  assert.equal(responses[1].result.structuredContent.health.summary_node_count > 0, true);
  assert.equal(responses[2].result.structuredContent.matches[0].session_id, "smoke-session");
  assert.match(responses[3].result.structuredContent.markdown, /smoke searchable context/u);
  assert.doesNotMatch(responses[3].result.structuredContent.markdown, /mcp__codex_lcm__/u);
  assert.equal(responses[4].result.structuredContent.summary.session_id, "smoke-session");
  assert.match(responses[4].result.structuredContent.summary.overview, /Smoke verified extractive summaries/u);
  assert.equal(responses[5].result.structuredContent.nodes.some((node: { kind: string }) => node.kind === "session"), true);
  assert.equal(responses[5].result.structuredContent.nodes.some((node: { kind: string }) => node.kind === "summary"), true);
  assert.equal(responses[5].result.structuredContent.edges.some((edge: { kind: string }) => edge.kind === "summary_source"), true);
  assert.match(responses[6].result.structuredContent.markdown, /smoke-old-dag-marker/u);
  assert.equal(responses[7].result.structuredContent.matches[0].session_id, "smoke-session");
  assert.equal(responses[8].result.structuredContent.description.target, "session");
  const nodeId = responses[8].result.structuredContent.description.summary_nodes[0].node_id;
  const expansionResponses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_expand",
        arguments: { nodeId, query: "smoke searchable context", limit: 4 },
      },
    },
  ]);
  assert.equal(expansionResponses[1].result.structuredContent.expansion.node.node_id, nodeId);
  assert.match(expansionResponses[1].result.structuredContent.expansion.markdown, /smoke searchable context/u);
  assert.doesNotMatch(fs.readFileSync(path.join(home, "events.jsonl"), "utf8"), /sk-proj-secret-value/u);

  const sourceEventId = readEvents().find((event) => event.hook_event === "UserPromptSubmit" && event.session_id === "smoke-session")?.event_id;
  assert.equal(typeof sourceEventId, "string");
  const memoryId = "88888888-8888-4888-8888-888888888888";
  const memoryResponses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_create_memory", arguments: { sessionId: "smoke-session", cwd: root, text: "Smoke durable memory initial.", kind: "decision", rationale: "The smoke source event supports it.", sourceEventIds: [sourceEventId], memoryId } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lcm_revise_memory", arguments: { sessionId: "smoke-session", cwd: root, memoryId, expectedRevision: 1, text: "Smoke durable memory replacement.", reason: "The replacement is more precise.", sourceEventIds: [sourceEventId] } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lcm_search_memories", arguments: { query: "durable memory replacement", cwd: root } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId, cwd: root } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "lcm_pack_context", arguments: { query: "durable memory replacement", cwd: root, budgetTokens: 350 } } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "lcm_deprecate_memory", arguments: { sessionId: "smoke-session", cwd: root, memoryId, expectedRevision: 2, reason: "This memory is no longer applicable.", sourceEventIds: [sourceEventId] } } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lcm_search_memories", arguments: { query: "durable memory replacement", cwd: root } } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "lcm_pack_context", arguments: { query: "durable memory replacement", cwd: root, budgetTokens: 350 } } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "lcm_delete_memory", arguments: { sessionId: "smoke-session", cwd: root, memoryId, expectedRevision: 3, reason: "This memory is explicitly invalidated.", sourceEventIds: [sourceEventId] } } },
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "lcm_pack_context", arguments: { query: "durable memory replacement", cwd: root, budgetTokens: 350 } } },
    { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId, cwd: root, includeContext: false } } },
  ]);
  assert.equal(memoryResponses[0].result.structuredContent.memory.revision, 1);
  assert.equal(memoryResponses[1].result.structuredContent.memory.revision, 2);
  assert.equal(memoryResponses[2].result.structuredContent.memories[0].memory_id, memoryId);
  assert.equal(memoryResponses[3].result.structuredContent.memory.source_context.sources[0].event_ids.includes(sourceEventId), true);
  assert.match(memoryResponses[4].result.structuredContent.markdown, /## Durable Memories/u);
  assert.equal(memoryResponses[6].result.structuredContent.memories.length, 0);
  assert.doesNotMatch(memoryResponses[7].result.structuredContent.markdown, /Smoke durable memory replacement/u);
  assert.doesNotMatch(memoryResponses[9].result.structuredContent.markdown, /Smoke durable memory replacement/u);
  assert.equal(memoryResponses[10].result.structuredContent.memory.memory.status, "deleted");
  assert.equal(memoryResponses[10].result.structuredContent.memory.revisions.length, 4);
  assert.equal(readEvents().filter((event) => event.hook_event === "Memory" && event.payload.memory_id === memoryId).length, 4);
  const legacyNote = runMcp([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_record_note", arguments: { sessionId: "smoke-session", cwd: root, text: "Smoke legacy Note raw fallback." } } }]);
  const legacyNoteId = legacyNote[0].result.structuredContent.event.event_id;
  fs.rmSync(path.join(home, "index.sqlite"));
  const rawFallbackPack = runMcp([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_pack_context", arguments: { query: "legacy Note raw fallback", cwd: root, budgetTokens: 350 } } }]);
  assert.match(rawFallbackPack[0].result.structuredContent.markdown, /Smoke legacy Note raw fallback/u);
  assert.equal(rawFallbackPack[0].result.structuredContent.sources.some((source: { kind: string; event_id?: string }) => source.kind === "note" && source.event_id === legacyNoteId), true);
  const rebuilt = runMcp([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_get_memory", arguments: { memoryId, cwd: root, includeContext: false } } }]);
  assert.equal(rebuilt[0].result.structuredContent.memory.memory.revision, 4);

  process.stdout.write(`Smoke test passed with CODEX_LCM_HOME=${home}\n`);
  process.stdout.write("memory lifecycle passed\n");
} finally {
  if (process.env.CODEX_LCM_KEEP_SMOKE !== "1") {
    fs.rmSync(home, { recursive: true, force: true });
    process.stdout.write(`cleanup: removed ${home}\n`);
  }
}

function runHook(event: string, payload: unknown): void {
  const result = spawnSync(process.execPath, ["--no-warnings", "bin/codex-lcm", "hook", event], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: "utf8",
    env: { ...process.env, CODEX_LCM_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
}

function runMcp(requests: unknown[]) {
  const result = spawnSync(process.execPath, ["--no-warnings", "bin/codex-lcm", "mcp"], {
    cwd: root,
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    encoding: "utf8",
    env: { ...process.env, CODEX_LCM_HOME: home },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

function readEvents(): Array<{ event_id: string; hook_event: string; session_id: string; payload: Record<string, unknown> }> {
  return fs.readFileSync(path.join(home, "events.jsonl"), "utf8").trim().split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line));
}
