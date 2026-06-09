import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const home = fs.mkdtempSync(path.join(os.tmpdir(), "codex-lcm-smoke-"));

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

  const responses = runMcp([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } },
    {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "lcm_search_sessions",
        arguments: { query: "searchable", limit: 5 },
      },
    },
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "lcm_pack_context",
        arguments: { query: "searchable", budgetTokens: 120 },
      },
    },
  ]);

  assert.equal(responses[1].result.structuredContent.matches[0].session_id, "smoke-session");
  assert.match(responses[2].result.structuredContent.markdown, /smoke searchable context/u);
  assert.doesNotMatch(fs.readFileSync(path.join(home, "events.jsonl"), "utf8"), /sk-proj-secret-value/u);

  process.stdout.write(`Smoke test passed with CODEX_LCM_HOME=${home}\n`);
} finally {
  if (process.env.CODEX_LCM_KEEP_SMOKE !== "1") {
    fs.rmSync(home, { recursive: true, force: true });
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
