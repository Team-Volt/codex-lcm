import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

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

test("hook command reports raw fsync failure and persists on retry", () => {
  // Given: the real hook CLI loads a fault injector that fails raw fsync.
  const home = tempHome();
  const preloadPath = path.join(tempHome("codex-lcm-fsync-preload-"), "fail-fsync.mjs");
  fs.writeFileSync(
    preloadPath,
    'import fs from "node:fs"; const original = fs.fsyncSync; let calls = 0; fs.fsyncSync = (...args) => { calls += 1; if (calls === 1) throw new Error("forced raw fsync failure"); return original(...args); };\n',
  );
  const input = JSON.stringify({
    session_id: "hook-fsync-retry",
    cwd: "/tmp/hook-fsync-retry",
    prompt: "persist once after fsync recovers",
  });

  // When: raw durability fails before the hook can acknowledge the event.
  const blocked = spawnSync(process.execPath, [
    "--no-warnings",
    "--import",
    preloadPath,
    "bin/codex-lcm",
    "hook",
    "UserPromptSubmit",
  ], {
    cwd: path.resolve("."),
    encoding: "utf8",
    input,
    env: { ...process.env, CODEX_LCM_HOME: home },
  });

  // Then: failure is visible and rollback leaves no acknowledged raw event.
  assert.equal(blocked.status, 1, blocked.stderr);
  assert.match(blocked.stderr, /forced raw fsync failure/u);
  assert.equal(fs.existsSync(path.join(home, "events.jsonl")), false);

  // When: the same hook is retried without the injected failure.
  const retried = runCli(["hook", "UserPromptSubmit"], { input, env: { CODEX_LCM_HOME: home } });

  // Then: exactly one raw and indexed event persists.
  assertCliOk(retried);
  assert.equal(readJsonl(path.join(home, "events.jsonl")).length, 1);
  const health = runCli(["health", "--json"], { env: { CODEX_LCM_HOME: home } });
  assertCliOk(health);
  assert.equal(JSON.parse(health.stdout).event_count, 1);
});

test("hook recovers after its lock-owning worker terminates", async () => {
  // Given: a worker owns the raw-log coordinator, enters its callback, then terminates.
  const home = tempHome();
  const rawLogPath = path.join(home, "events.jsonl");
  const rawLogModuleUrl = new URL("../src/raw-log.ts", import.meta.url).href;
  const writer = new Worker(String.raw`
    const { parentPort, workerData } = require("node:worker_threads");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    (async () => {
      const { withRawLogLock } = await import(workerData.rawLogModuleUrl);
      withRawLogLock(workerData.rawLogPath, () => {
        parentPort.postMessage("locked");
        Atomics.wait(wait, 0, 0);
      });
    })();
  `, { eval: true, workerData: { rawLogModuleUrl, rawLogPath } });
  await new Promise<void>((resolve, reject) => {
    writer.once("message", () => resolve());
    writer.once("error", reject);
  });
  await writer.terminate();
  const input = JSON.stringify({ session_id: "worker-owner-retry", cwd: "/tmp/worker-owner", prompt: "persist after worker owner crash" });

  // When: another real hook writes after SQLite releases the terminated worker's transaction.
  const retried = runCli(["hook", "UserPromptSubmit"], { input, env: { CODEX_LCM_HOME: home }, timeout: 15_000 });

  // Then: the retry persists exactly one event without manual lock cleanup.
  assertCliOk(retried);
  assert.equal(readJsonl(rawLogPath).length, 1);
  const health = runCli(["health", "--json"], { env: { CODEX_LCM_HOME: home } });
  assertCliOk(health);
  assert.equal(JSON.parse(health.stdout).event_count, 1);
});

test("hook command redacts credential URI passwords before persistence", () => {
  const home = tempHome();
  const password = "audit-password";
  const result = runCli(["hook", "UserPromptSubmit"], {
    input: JSON.stringify({
      session_id: "credential-uri-session",
      cwd: "/tmp/credential-uri",
      prompt: `connect to redis://:${password}@cache.example.test/0`,
    }),
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  const persisted = fs.readFileSync(path.join(home, "events.jsonl"), "utf8");
  assert.doesNotMatch(persisted, new RegExp(password, "u"));
  assert.match(persisted, /redis:\/\/:\[REDACTED:secret\]@cache\.example\.test\/0/u);
});

test("cleanup --json treats a fresh home as an empty no-op", () => {
  const home = tempHome();
  const result = runCli(["cleanup", "--json"], {
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  assert.deepEqual(JSON.parse(result.stdout), {
    applied: false,
    raw_log_preserved: true,
    index_path: path.join(home, "index.sqlite"),
    database_bytes_before: 0,
    database_bytes_after: 0,
    event_fts_rows_before: 0,
    event_fts_rows_after: 0,
    projected_event_fts_rows: 0,
    event_text_bytes_before: 0,
    event_text_bytes_after: 0,
    projected_summaries_to_rebuild: 0,
    summaries_rebuilt: 0,
    vacuumed: false,
  });
});

test("CLI rejects missing and invalid option values", () => {
  const cases = [
    { args: ["import-codex-sessions", "--from"], flag: "--from" },
    { args: ["import-codex-sessions", "--batch-size", "nope"], flag: "--batch-size" },
    { args: ["sessions", "--limit", "0"], flag: "--limit" },
    { args: ["status", "--codex-home", "--json"], flag: "--codex-home" },
  ];

  for (const { args, flag } of cases) {
    const result = runCli(args, { env: { CODEX_LCM_HOME: tempHome() } });
    assert.equal(result.status, 1, `${args.join(" ")} unexpectedly succeeded`);
    assert.match(result.stderr, new RegExp(flag, "u"));
  }
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

test("hook command preserves truncated large tool output below the input overflow threshold", () => {
  const home = tempHome();
  const marker = "RECOVERABLE-LARGE-OUTPUT-MARKER";
  const result = runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "large-tool-output-session",
      cwd: "/tmp/large-tool-output",
      tool_name: "build",
      tool_response: `${"x".repeat(70 * 1024)}${marker}`,
    }),
    env: { CODEX_LCM_HOME: home },
  });

  assertCliOk(result);
  const [event] = readJsonl(path.join(home, "events.jsonl")) as Array<{
    payload: { overflow_ref?: { path?: string } };
  }>;
  const overflowPath = event.payload.overflow_ref?.path ?? "";
  assert.equal(fs.existsSync(overflowPath), true);
  assert.match(fs.readFileSync(overflowPath, "utf8"), new RegExp(marker, "u"));
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

test("tool hooks skip Git metadata probes", () => {
  if (process.platform === "win32") return;
  const home = tempHome();
  const repoRootResult = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: process.cwd(), encoding: "utf8" });
  assert.equal(repoRootResult.status, 0, repoRootResult.stderr);
  const repoRoot = repoRootResult.stdout.trim();
  const binDir = tempHome("codex-lcm-fake-git-");
  const gitLog = path.join(binDir, "git.log");
  const fakeGit = path.join(binDir, "git");
  fs.writeFileSync(fakeGit, '#!/bin/sh\nprintf "called\\n" >> "$GIT_LOG"\nexit 1\n', { mode: 0o755 });
  const env = {
    CODEX_LCM_HOME: home,
    GIT_LOG: gitLog,
    PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  const start = runCli(["hook", "SessionStart"], {
    input: JSON.stringify({ session_id: "tool-git-session", cwd: process.cwd() }),
    env: { CODEX_LCM_HOME: home },
  });
  assertCliOk(start);

  for (const hookEvent of ["PreToolUse", "PostToolUse"]) {
    const result = runCli(["hook", hookEvent], {
      input: JSON.stringify({ session_id: "tool-git-session", cwd: process.cwd(), tool_name: "Read" }),
      env,
    });
    assertCliOk(result);
  }

  assert.equal(fs.existsSync(gitLog), false);
  const toolEvents = (readJsonl(path.join(home, "events.jsonl")) as Array<{
    hook_event: string;
    repo_root?: string;
  }>).filter((event) => event.hook_event === "PreToolUse" || event.hook_event === "PostToolUse");
  assert.equal(toolEvents.length, 2);
  assert.equal(toolEvents.every((event) => typeof event.repo_root === "string" && event.repo_root.length > 0), true);
  assert.equal(toolEvents.every((event) => fs.realpathSync(event.repo_root ?? "") === fs.realpathSync(repoRoot)), true);
});

test("tool hook closes storage when session metadata lookup fails", () => {
  // Given: the real hook CLI loads an injector that fails tool-session lookup and records storage cleanup.
  const home = tempHome();
  const fixtureDir = tempHome("codex-lcm-hook-close-");
  const closeMarker = path.join(fixtureDir, "closed");
  const preloadPath = path.join(fixtureDir, "fail-session-lookup.mjs");
  const storageModuleUrl = new URL("../src/storage.ts", import.meta.url).href;
  fs.writeFileSync(preloadPath, `
    import fs from "node:fs";
    const { LcmStorage } = await import(process.env.STORAGE_MODULE_URL);
    const originalClose = LcmStorage.prototype.close;
    LcmStorage.prototype.close = function() {
      fs.writeFileSync(process.env.CLOSE_MARKER, "closed");
      return originalClose.call(this);
    };
    LcmStorage.prototype.getCurrentSession = function() {
      throw new Error("forced tool-session lookup failure");
    };
  `);

  // When: a tool hook fails after storage opens but before ingest begins.
  const result = spawnSync(process.execPath, [
    "--no-warnings",
    "--import",
    preloadPath,
    "bin/codex-lcm",
    "hook",
    "PreToolUse",
  ], {
    cwd: path.resolve("."),
    encoding: "utf8",
    input: JSON.stringify({ session_id: "tool-close-session", cwd: "/tmp/tool-close", tool_name: "Read" }),
    env: { ...process.env, CLOSE_MARKER: closeMarker, CODEX_LCM_HOME: home, STORAGE_MODULE_URL: storageModuleUrl },
  });

  // Then: the failure remains visible and the opened storage is closed.
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /forced tool-session lookup failure/u);
  assert.equal(fs.existsSync(closeMarker), true);
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

test("post-compaction recovery stays pending until lcm_pack_context completes", () => {
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
  const recoveryDir = path.join(home, "post-compact-recovery");
  const [marker] = fs.readdirSync(recoveryDir);
  assert.equal(fs.statSync(recoveryDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(recoveryDir, marker)).mode & 0o777, 0o600);

  const payload = JSON.stringify({
    session_id: "compact-once-session",
    cwd: "/tmp/compact-once-project",
    hook_event_name: "SessionStart",
    source: "compact",
  });
  const first = runCli(["hook", "SessionStart"], { input: payload, env });
  const blocked = runCli(["hook", "Stop"], {
    input: JSON.stringify({
      session_id: "compact-once-session",
      cwd: "/tmp/compact-once-project",
    }),
    env,
  });
  const recovered = runCli(["hook", "PostToolUse"], {
    input: JSON.stringify({
      session_id: "compact-once-session",
      cwd: "/tmp/compact-once-project",
      tool_name: "mcp__codex_lcm__lcm_pack_context",
    }),
    env,
  });
  const stopped = runCli(["hook", "Stop"], {
    input: JSON.stringify({
      session_id: "compact-once-session",
      cwd: "/tmp/compact-once-project",
    }),
    env,
  });

  assertCliOk(first);
  assertCliOk(blocked);
  assertCliOk(recovered);
  assertCliOk(stopped);
  assert.match(first.stdout, /lcm_pack_context/u);
  assert.equal(JSON.parse(blocked.stdout).decision, "block");
  assert.equal(recovered.stdout, "");
  assert.equal(stopped.stdout, "");
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
