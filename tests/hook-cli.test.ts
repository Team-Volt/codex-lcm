import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertCliOk, readJsonl, runCli, tempHome } from "./helpers.ts";

test("hook command ingests a synthetic projectless prompt event", () => {
  const home = tempHome();
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "hook-session",
      cwd: "/tmp/projectless",
      prompt: "find this later",
    }),
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  const lines = readJsonl(path.join(home, "events.jsonl"));
  assert.equal(lines.length, 1);
  assert.equal((lines[0] as { session_id: string }).session_id, "hook-session");

  const health = runCli(["health", "--json"], {
    env: { CODEX_LCM_HOME: home },
  });
  assertCliOk(health);
  assert.equal(JSON.parse(health.stdout).event_count, 1);
});

test("hook command rejects oversized stdin before writing storage", () => {
  const home = tempHome();
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: "x".repeat(512 * 1024 + 1),
    env: { CODEX_LCM_HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds the 524288 byte limit/u);
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);
});

test("hook command captures git metadata as optional session metadata", () => {
  const home = tempHome();
  const repo = tempHome("codex-lcm-git-");
  const gitInit = spawnSync("git", ["init", "-b", "feature/test"], { cwd: repo, encoding: "utf8" });
  assert.equal(gitInit.status, 0, gitInit.stderr);

  const result = runCli(["hook", "SessionStart"], {
    input: JSON.stringify({ session_id: "git-session", cwd: repo }),
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  const [event] = readJsonl(path.join(home, "events.jsonl")) as Array<{
    repo_root?: string;
    git_branch?: string;
  }>;
  assert.equal(fs.realpathSync(event.repo_root ?? ""), fs.realpathSync(repo));
  assert.equal(event.git_branch, "feature/test");
});
