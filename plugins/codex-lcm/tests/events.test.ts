import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryEvent, normalizeHookEvent } from "../src/events.ts";

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

test("defaults memory scope to repo and normalizes deterministic tags", () => {
  const event = createMemoryEvent({
    sessionId: "session-123",
    cwd: "/tmp/repo/project",
    text: "Use the existing migration path.",
    kind: "decision",
    tags: ["  UI Design  ", "ui design", "ＦＡＣＴ"],
    rationale: "The user explicitly chose this path.",
    sourceEventIds: ["event-1"],
    memoryId: "11111111-1111-4111-8111-111111111111",
    now: fixedNow,
    repo: { repoRoot: "/tmp/repo" },
  });

  assert.equal(event.hook_event, "Memory");
  assert.equal(event.payload.operation, "create");
  assert.equal(event.payload.memory_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(event.payload.revision, 1);
  assert.deepEqual(event.payload.scope, { kind: "repo", key: "/tmp/repo" });
  assert.deepEqual(event.payload.tags, ["fact", "ui-design"]);
});

test("defaults projectless memory scope to global", () => {
  const event = createMemoryEvent({
    sessionId: "session-123",
    cwd: "/tmp/projectless",
    text: "Prefer explicit errors.",
    kind: "lesson",
    rationale: "Observed in the current session.",
    sourceEventIds: ["event-1"],
    memoryId: "22222222-2222-4222-8222-222222222222",
    now: fixedNow,
  });

  assert.deepEqual(event.payload.scope, { kind: "global" });
});

test("rejects invalid memory fields", () => {
  const base = {
    sessionId: "session-123",
    cwd: "/tmp/projectless",
    text: "Remember this.",
    kind: "fact",
    rationale: "Observed in the current session.",
    sourceEventIds: ["event-1"],
  } as const;

  assert.throws(() => createMemoryEvent({ ...base, kind: "invalid" }), /Invalid memory kind: invalid/u);
  assert.throws(() => createMemoryEvent({ ...base, tags: ["   "] }), /Memory tag must not be empty after normalization./u);
  assert.throws(() => createMemoryEvent({ ...base, tags: ["x".repeat(65)] }), /Memory tag exceeds 64 Unicode code points./u);
  assert.throws(() => createMemoryEvent({ ...base, sourceEventIds: [""] }), /Memory source event ID must be a non-empty string./u);
  assert.throws(() => createMemoryEvent({ ...base, sourceEventIds: [] }), /Memory source event IDs must not be empty./u);
  assert.throws(
    () => createMemoryEvent({ ...base, sourceEventIds: Array.from({ length: 33 }, (_, index) => `event-${index}`) }),
    /Memory source event IDs exceed 32 values./u,
  );
  assert.throws(
    () => createMemoryEvent({ ...base, tags: Array.from({ length: 33 }, (_, index) => `tag-${index}`) }),
    /Memory tags exceed 32 unique values./u,
  );
});

test("legacy note envelope remains unchanged", () => {
  const event = normalizeHookEvent({
    hookEvent: "Note",
    rawInput: JSON.stringify({ session_id: "session-123", cwd: "/tmp/projectless", note: "legacy note" }),
    env: {},
    now: fixedNow,
  });

  assert.deepEqual(event, {
    schema_version: 1,
    event_id: "ce6b15eaa40e8b3af1160ca332f824791a9ef22fff8d679f5f2485f47aeb15a0",
    timestamp: "2026-06-09T12:00:00.000Z",
    hook_event: "Note",
    session_id: "session-123",
    cwd: "/tmp/projectless",
    payload: { session_id: "session-123", cwd: "/tmp/projectless", note: "legacy note" },
    redactions: [],
    truncations: [],
    raw_input_sha256: "b9f92d1c293a0f10add06842d4c5a6b48e69e037b7e2c06f9a5fc4806d4d8ddc",
    original_bytes: 74,
    sanitized_bytes: 127,
  });
});
