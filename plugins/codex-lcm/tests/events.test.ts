import assert from "node:assert/strict";
import test from "node:test";

import { normalizeHookEvent } from "../src/events.ts";

const fixedNow = () => new Date("2026-06-09T12:00:00.000Z");

test("normalizes Codex-style hook payloads without project as primary boundary", () => {
  const event = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      session_id: "session-123",
      cwd: "/tmp/projectless",
      prompt: "remember this",
      extra_field: { keep: true },
    }),
    env: {},
    now: fixedNow,
  });

  assert.equal(event.schema_version, 1);
  assert.equal(event.hook_event, "UserPromptSubmit");
  assert.equal(event.session_id, "session-123");
  assert.equal(event.cwd, "/tmp/projectless");
  assert.equal(event.project, undefined);
  assert.equal(event.payload.prompt, "remember this");
  assert.deepEqual(event.payload.extra_field, { keep: true });
  assert.equal(event.raw_input_sha256, "9f2e0ba73fc9eaea101940d45cfe72e65bcc9712703a07b19b02aea027b3b9d4");
});

test("accepts camelCase session and tool keys", () => {
  const event = normalizeHookEvent({
    hookEvent: "PostToolUse",
    rawInput: JSON.stringify({
      sessionId: "camel-session",
      cwd: "/tmp/cwd",
      toolName: "Read",
      toolArgs: { file_path: "README.md" },
      toolResult: { textResultForLlm: "hello" },
    }),
    env: {},
    now: fixedNow,
  });

  assert.equal(event.session_id, "camel-session");
  assert.equal(event.tool_name, "Read");
  assert.deepEqual(event.payload.toolArgs, { file_path: "README.md" });
  assert.deepEqual(event.payload.toolResult, { textResultForLlm: "hello" });
});

test("uses only Codex session environment fallback keys", () => {
  const codexEvent = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      cwd: "/tmp/cwd",
      prompt: "env session fallback",
    }),
    env: { CODEX_SESSION_ID: "codex-env-session" },
    now: fixedNow,
  });

  assert.equal(codexEvent.session_id, "codex-env-session");

  const nonCodexEvent = normalizeHookEvent({
    hookEvent: "UserPromptSubmit",
    rawInput: JSON.stringify({
      cwd: "/tmp/cwd",
      prompt: "non-codex env fallback",
    }),
    env: { CLAUDE_SESSION_ID: "claude-env-session" },
    now: fixedNow,
  });

  assert.notEqual(nonCodexEvent.session_id, "claude-env-session");
  assert.equal(nonCodexEvent.session_id.startsWith("unknown-"), true);
});

test("malformed stdin becomes a sanitized parse-error event instead of throwing", () => {
  const event = normalizeHookEvent({
    hookEvent: "SessionStart",
    rawInput: "{not json sk-proj-secret-value authToken=tok_123456789",
    env: { PWD: "/tmp/fallback" },
    now: fixedNow,
  });

  assert.equal(event.session_id.startsWith("unknown-"), true);
  assert.equal(event.cwd, "/tmp/fallback");
  assert.equal(event.payload.parse_error, true);
  assert.equal(event.payload.raw_preview, "{not json sk-proj_[REDACTED:token] authToken=[REDACTED:secret]");
  assert.equal(event.redactions.length, 2);
});

test("redacts secret-shaped top-level metadata before persistence", () => {
  const event = normalizeHookEvent({
    hookEvent: "PostToolUse",
    rawInput: JSON.stringify({
      session_id: "session-sk-proj-secret-value",
      cwd: "/tmp/cwd-Authorization: Bearer metadata-secret",
      project: "project-ghp_1234567890123456789012345",
      tool_name: "tool-xoxb-1234567890123456",
      tool_response: "Authorization: Bearer payload-secret",
    }),
    env: {},
    now: fixedNow,
    repo: {
      repoRoot: "/tmp/repo-Authorization: Bearer repo-secret",
      gitBranch: "branch-ghp_1234567890123456789012345",
    },
  });

  const serialized = JSON.stringify(event);
  assert.doesNotMatch(serialized, /sk-proj-secret-value/u);
  assert.doesNotMatch(serialized, /metadata-secret/u);
  assert.doesNotMatch(serialized, /ghp_1234567890123456789012345/u);
  assert.doesNotMatch(serialized, /xoxb-1234567890123456/u);
  assert.doesNotMatch(serialized, /repo-secret/u);
  assert.doesNotMatch(serialized, /payload-secret/u);
  assert.match(event.session_id, /sk-proj_\[REDACTED:token\]/u);
  assert.match(event.cwd, /Bearer \[REDACTED:token\]/u);
  assert.match(event.project ?? "", /ghp_\[REDACTED:token\]/u);
  assert.match(event.tool_name ?? "", /xox\[REDACTED:token\]/u);
  assert.match(event.repo_root ?? "", /Bearer \[REDACTED:token\]/u);
  assert.match(event.git_branch ?? "", /ghp_\[REDACTED:token\]/u);
  assert.equal(event.payload.tool_response, "Authorization: Bearer [REDACTED:token]");
});
