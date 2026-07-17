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

test("hook command stores a sanitized overflow reference for oversized valid input", () => {
  const home = tempHome();
  const secret = "sk-test-overflow-secret-1234567890";
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "oversized-hook-session",
      cwd: "/tmp/oversized-hook",
      api_key: secret,
      prompt: "x".repeat(512 * 1024),
    }),
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  const [event] = readJsonl(path.join(home, "events.jsonl")) as Array<{
    session_id: string;
    payload: { overflow_ref?: { path?: string; sha256?: string; byte_count?: number } };
  }>;
  assert.equal(event.session_id, "oversized-hook-session");
  assert.match(event.payload.overflow_ref?.sha256 ?? "", /^[a-f0-9]{64}$/u);
  assert.equal((event.payload.overflow_ref?.byte_count ?? 0) > 512 * 1024, true);
  const overflowPath = event.payload.overflow_ref?.path ?? "";
  assert.equal(fs.existsSync(overflowPath), true);
  const overflow = fs.readFileSync(overflowPath, "utf8");
  assert.doesNotMatch(overflow, new RegExp(secret, "u"));
  assert.match(overflow, /\[REDACTED:secret\]/u);
});

test("hook command still rejects input above the overflow safety ceiling", () => {
  const home = tempHome();
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: "x".repeat(8 * 1024 * 1024 + 1),
    env: { CODEX_LCM_HOME: home },
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /exceeds the 8388608 byte limit/u);
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

test("SubagentStop imports only the child portion of a forked rollout", () => {
  const home = tempHome();
  const parentId = "019f482f-65a8-7a31-a79c-2cecf2e87c3e";
  const childId = "019f482f-c8cd-7b60-ac99-a302e7fdb5bf";
  const transcript = path.join(
    tempHome("codex-subagent-rollout-"),
    `rollout-2026-07-09T14-41-58-${childId}.jsonl`,
  );
  const rows = [
    { timestamp: "2026-07-09T18:41:33.000Z", type: "session_meta", payload: { id: parentId, cwd: "/tmp/subagent-capture" } },
    { timestamp: "2026-07-09T18:41:34.000Z", type: "event_msg", payload: { type: "user_message", message: "inherited_parent_needle" } },
    {
      timestamp: "2026-07-09T18:41:35.000Z",
      type: "turn_context",
      payload: {
        turn_id: "inherited-parent-turn",
        cwd: "/tmp/inherited-parent",
        repo_root: "/tmp/inherited-parent-repo",
        git_branch: "inherited-parent-branch",
      },
    },
    { timestamp: "2026-07-09T18:41:58.000Z", type: "session_meta", payload: { id: childId, session_id: parentId, cwd: "/tmp/subagent-capture" } },
    { timestamp: "2026-07-09T18:41:59.000Z", type: "event_msg", payload: { type: "user_message", message: "child_prompt_needle" } },
    { timestamp: "2026-07-09T18:42:00.000Z", type: "event_msg", payload: { type: "agent_message", message: "child_result_needle" } },
  ];
  fs.writeFileSync(transcript, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);

  const result = runCli(["hook", "SubagentStop"], {
    input: JSON.stringify({
      session_id: parentId,
      cwd: "/tmp/subagent-capture",
      hook_event_name: "SubagentStop",
      agent_id: childId,
      agent_type: "default",
      agent_transcript_path: transcript,
    }),
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  const events = readJsonl(path.join(home, "events.jsonl")) as Array<{
    session_id: string;
    hook_event: string;
    payload: Record<string, unknown>;
    repo_root?: string;
    git_branch?: string;
  }>;
  const childEvents = events.filter((event) => event.session_id === childId);
  assert.deepEqual(childEvents.map((event) => event.hook_event), ["SessionStart", "UserPromptSubmit", "Stop"]);
  for (const event of childEvents) {
    assert.equal(event.payload.turn_id, undefined);
    assert.equal(event.repo_root, undefined);
    assert.equal(event.git_branch, undefined);
  }
  assert.match(JSON.stringify(childEvents), /child_prompt_needle/u);
  assert.match(JSON.stringify(childEvents), /child_result_needle/u);
  assert.doesNotMatch(JSON.stringify(events), /inherited_parent_needle/u);
  assert.equal(events.some((event) => event.session_id === parentId && event.hook_event === "SubagentStop"), true);
});

test("SubagentStop reports a missing transcript without losing the parent event", () => {
  const home = tempHome();
  const parentId = "019f482f-65a8-7a31-a79c-2cecf2e87c3e";
  const transcript = path.join(tempHome("codex-subagent-missing-"), "missing.jsonl");
  const result = runCli(["hook", "SubagentStop"], {
    input: JSON.stringify({
      session_id: parentId,
      cwd: "/tmp/subagent-capture",
      hook_event_name: "SubagentStop",
      agent_transcript_path: transcript,
    }),
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  assert.match(result.stderr, /failed to import subagent transcript/u);
  assert.equal(result.stderr.includes(transcript), true);
  const events = readJsonl(path.join(home, "events.jsonl")) as Array<{
    session_id: string;
    hook_event: string;
  }>;
  assert.deepEqual(events.map((event) => [event.session_id, event.hook_event]), [[parentId, "SubagentStop"]]);
});

test("PostCompact hook emits no unsupported response", () => {
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
});

test("PostCompact pending marker nudges the next compact SessionStart to recall LCM", () => {
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
  assert.match(output.hookSpecificOutput.additionalContext, /continue unfinished work/u);
});

test("PostCompact pending marker nudges the next user prompt when Desktop compact stops", () => {
  const home = tempHome();
  const env = { CODEX_LCM_HOME: home };
  const postCompact = runCli(["hook", "PostCompact"], {
    input: JSON.stringify({
      session_id: "manual-compact-session",
      cwd: "/tmp/manual-compact-project",
      hook_event_name: "PostCompact",
      trigger: "manual",
    }),
    env,
  });
  assertCliOk(postCompact);

  const userPrompt = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "manual-compact-session",
      cwd: "/tmp/manual-compact-project",
      hook_event_name: "UserPromptSubmit",
      prompt: "continue",
    }),
    env,
  });

  assertCliOk(userPrompt);
  const output: unknown = JSON.parse(userPrompt.stdout);
  assertHookAdditionalContextOutput(output);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /POST-COMPACTION LCM RECOVERY/u);
  assert.match(output.hookSpecificOutput.additionalContext, /lcm_pack_context/u);
});

test("PostCompact pending marker nudges the next same-turn tool result", () => {
  // Given
  const home = tempHome();
  const env = { CODEX_LCM_HOME: home };
  assertCliOk(runCli(["hook", "PostCompact"], {
    input: JSON.stringify({ session_id: "same-turn-session", cwd: "/tmp/same-turn", trigger: "auto" }),
    env,
  }));

  // When
  const postToolUse = runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "same-turn-session",
      cwd: "/tmp/same-turn",
      tool_name: "Bash",
      tool_input: { command: "pwd" },
      tool_response: "/tmp/same-turn",
    }),
    env,
  });

  // Then
  assertCliOk(postToolUse);
  const output: unknown = JSON.parse(postToolUse.stdout);
  assertHookAdditionalContextOutput(output);
  assert.equal(output.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(output.hookSpecificOutput.additionalContext, /lcm_pack_context/u);
});

test("PostCompact pending marker blocks same-turn completion until LCM recovery", () => {
  // Given
  const home = tempHome();
  const env = { CODEX_LCM_HOME: home };
  assertCliOk(runCli(["hook", "PostCompact"], {
    input: JSON.stringify({ session_id: "same-turn-stop-session", cwd: "/tmp/same-turn-stop", trigger: "auto" }),
    env,
  }));

  // When
  const stop = runCli(["hook", "Stop"], {
    input: JSON.stringify({ session_id: "same-turn-stop-session", cwd: "/tmp/same-turn-stop" }),
    env,
  });

  // Then
  assertCliOk(stop);
  const output = JSON.parse(stop.stdout) as { readonly decision: string; readonly reason: string };
  assert.equal(output.decision, "block");
  assert.equal(output.reason, "Post-compaction LCM recovery required: call `lcm_pack_context`, then continue.");
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
  assert.equal(postCompact.stdout, "");

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
