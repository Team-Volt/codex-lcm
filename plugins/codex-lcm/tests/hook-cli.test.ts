import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertCliOk, clearDerivedSummaries, readJsonl, runCli, tempHome } from "./helpers.ts";

type HookAdditionalContextOutput = {
  readonly hookSpecificOutput: {
    readonly hookEventName: string;
    readonly additionalContext: string;
  };
};

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

test("PostCompact hook output nudges the next compact SessionStart to recall LCM", () => {
  const home = tempHome();
  const env = { CODEX_LCM_HOME: home };
  const postCompact = runCli(["hook", "PostCompact"], {
    input: JSON.stringify({
      session_id: "compact-session",
      turn_id: "turn-1",
      cwd: "/tmp/compact-project",
      hook_event_name: "PostCompact",
      trigger: "auto",
    }),
    env,
  });
  assertCliOk(postCompact);
  assert.equal(postCompact.stdout, "");

  const sessionStart = runCli(["hook", "SessionStart"], {
    input: JSON.stringify({
      session_id: "compact-session",
      cwd: "/tmp/compact-project",
      hook_event_name: "SessionStart",
      source: "compact",
    }),
    env,
  });

  assertCliOk(sessionStart);
  const output: unknown = JSON.parse(sessionStart.stdout);
  assertHookAdditionalContextOutput(output);
  assert.equal(output.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(output.hookSpecificOutput.additionalContext, /POST-COMPACTION LCM RECOVERY/u);
  assert.match(output.hookSpecificOutput.additionalContext, /lcm_pack_context/u);
});

test("post-compaction LCM nudge is emitted once per compacted session", () => {
  const home = tempHome();
  const env = { CODEX_LCM_HOME: home };
  const postCompact = runCli(["hook", "PostCompact"], {
    input: JSON.stringify({
      session_id: "compact-once-session",
      cwd: "/tmp/compact-once-project",
      hook_event_name: "PostCompact",
      trigger: "manual",
    }),
    env,
  });
  assertCliOk(postCompact);

  const payload = JSON.stringify({
    session_id: "compact-once-session",
    cwd: "/tmp/compact-once-project",
    hook_event_name: "SessionStart",
    source: "compact",
  });
  const first = runCli(["hook", "SessionStart"], { input: payload, env });
  const second = runCli(["hook", "SessionStart"], { input: payload, env });

  assertCliOk(first);
  assertCliOk(second);
  assert.match(first.stdout, /lcm_pack_context/u);
  assert.equal(second.stdout, "");
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
  assert.deepEqual(stats.hook_event_counts, { UserPromptSubmit: 9 });
  assert.deepEqual(stats.summary_nodes_by_depth, { "0": 2, "1": 1 });
  assert.deepEqual(stats.summary_nodes_by_source_type, { events: 2, nodes: 1 });
  assert.equal(stats.sessions_with_summary_nodes, 1);
  assert.equal(stats.max_summary_depth, 1);
  assert.equal(stats.graph_nodes_by_kind.event, 9);
  assert.equal(stats.graph_edges_by_kind.contains, 9);
  assert.equal(stats.graph_edges_by_kind.summary_source, 11);
});

test("stats command does not rebuild derived summaries", () => {
  const home = tempHome();
  for (let index = 0; index < 9; index += 1) {
    const hook = runCli(["hook", "UserPromptSubmit"], {
      input: JSON.stringify({
        session_id: "cli-readonly-stats-session",
        cwd: "/tmp/cli-readonly-stats",
        prompt: `cli readonly stats high signal prompt ${index}`,
      }),
      env: { CODEX_LCM_HOME: home },
    });
    assertCliOk(hook);
  }
  clearDerivedSummaries(home);

  const result = runCli(["stats", "--json"], {
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  const stats = JSON.parse(result.stdout);
  assert.equal(stats.event_count, 9);
  assert.equal(stats.summary_count, 0);
  assert.equal(stats.summary_node_count, 0);
  assert.equal(stats.index_error, undefined);
});

test("context-plan command reports budget pressure as JSON", () => {
  const home = tempHome();
  for (let index = 0; index < 12; index += 1) {
    const hook = runCli(["hook", "UserPromptSubmit"], {
      input: JSON.stringify({
        session_id: "cli-context-plan-session",
        cwd: "/tmp/cli-context-plan",
        prompt: `cli context budget pressure ${index} ${"signal ".repeat(40)}`,
      }),
      env: { CODEX_LCM_HOME: home },
    });
    assertCliOk(hook);
  }

  const result = runCli([
    "context-plan",
    "--session-id",
    "cli-context-plan-session",
    "--model-context-window",
    "2000",
    "--auto-compact-token-limit",
    "200",
    "--json",
  ], {
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.session_id, "cli-context-plan-session");
  assert.equal(plan.state, "over_limit");
  assert.equal(plan.can_control_compaction, false);
  assert.equal(plan.suggested_tools.includes("lcm_pack_context"), true);
});

function assertHookAdditionalContextOutput(value: unknown): asserts value is HookAdditionalContextOutput {
  assert.equal(isRecord(value), true);
  if (!isRecord(value)) return;
  const hookSpecificOutput = value.hookSpecificOutput;
  assert.equal(isRecord(hookSpecificOutput), true);
  if (!isRecord(hookSpecificOutput)) return;
  assert.equal(typeof hookSpecificOutput.hookEventName, "string");
  assert.equal(typeof hookSpecificOutput.additionalContext, "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
