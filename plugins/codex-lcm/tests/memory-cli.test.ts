import assert from "node:assert/strict";
import test from "node:test";

import { assertCliOk, readJsonl, runCli, runMcp, tempHome } from "./helpers.ts";

test("memory CLI lists, searches, and shows durable memory when enabled", () => {
  // Given
  const home = tempHome();
  const cwd = "/tmp/memory-cli";
  const source = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({ session_id: "memory-cli", cwd, prompt: "Use the deployment checklist." }),
    env: { CODEX_LCM_HOME: home },
  });
  assertCliOk(source);
  const eventId = (readJsonl(`${home}/events.jsonl`)[0] as { readonly event_id: string }).event_id;
  assert.equal(typeof eventId, "string");
  const memoryId = "77777777-7777-4777-8777-777777777777";
  runMcp([{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lcm_create_memory", arguments: {
    sessionId: "memory-cli", cwd, text: "Follow the deployment checklist.", kind: "workflow",
    scope: { kind: "global" }, rationale: "User established the workflow.", sourceEventIds: [eventId], memoryId,
  } } }], { CODEX_LCM_HOME: home });
  const env = { CODEX_LCM_HOME: home, CODEX_LCM_MEMORY_ENABLED: "1" };

  // When
  const list = runCli(["memory", "list"], { env });
  const search = runCli(["memory", "search", "deployment"], { env });
  const show = runCli(["memory", "show", memoryId], { env });

  // Then
  assertCliOk(list);
  assertCliOk(search);
  assertCliOk(show);
  assert.equal(JSON.parse(list.stdout)[0].memory_id, memoryId);
  assert.equal(JSON.parse(search.stdout)[0].memory_id, memoryId);
  const detail = JSON.parse(show.stdout);
  assert.equal(detail.memory.memory_id, memoryId);
  assert.equal(detail.revisions.length, 1);
  assert.equal(detail.source_context.events.some((event: { readonly event_id: string }) => event.event_id === eventId), true);
});

test("memory CLI stays hidden when durable memory is disabled", () => {
  // Given
  const env = { CODEX_LCM_HOME: tempHome(), CODEX_LCM_MEMORY_ENABLED: undefined };

  // When
  const help = runCli(["--help"], { env });
  const command = runCli(["memory", "list"], { env });

  // Then
  assertCliOk(help);
  assert.doesNotMatch(help.stdout, /codex-lcm memory/u);
  assert.equal(command.status, 1);
  assert.match(command.stderr, /Unknown command: memory/u);
});
