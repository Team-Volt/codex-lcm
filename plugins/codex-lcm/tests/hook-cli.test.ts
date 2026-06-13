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

test("stats command reports aggregate summary depth and graph counts", () => {
  const home = tempHome();
  for (let index = 0; index < 9; index += 1) {
    const hook = runCli(["hook", "UserPromptSubmit"], {
      input: JSON.stringify({
        session_id: "cli-stats-session",
        cwd: "/tmp/cli-stats",
        prompt: `cli stats high signal prompt ${index}`,
      }),
      env: { CODEX_LCM_HOME: home },
    });
    assertCliOk(hook);
  }

  const result = runCli(["stats", "--json"], {
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.event_count, 9);
  assert.equal(stats.summary_node_count, 3);
  assert.deepEqual(stats.summary_nodes_by_depth, { "0": 2, "1": 1 });
  assert.deepEqual(stats.summary_nodes_by_source_type, { events: 2, nodes: 1 });
  assert.equal(stats.sessions_with_summary_nodes, 1);
  assert.equal(stats.max_summary_depth, 1);
  assert.equal(stats.graph_nodes_by_kind.event, 9);
  assert.equal(stats.graph_edges_by_kind.contains, 9);
});
