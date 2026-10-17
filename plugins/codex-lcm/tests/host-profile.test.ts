import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_HOST,
  CODEX_HOOK_NAMES,
  encodeDynamicHookStdout,
  encodeHookStdout,
  parseCodexHookName,
  type ContextCapableHook,
  type HookStdout,
} from "../src/host-profile.ts";

test("PostCompact is typed as empty stdout and encodes to an empty string", () => {
  assert.equal(CODEX_HOST.hooks.PostCompact.stdout, "empty");
  assert.equal(encodeHookStdout("PostCompact", { kind: "empty" }), "");
});

test("PostCompact rejects additionalContext at the encoder boundary", () => {
  const event: string = "PostCompact";
  assert.throws(
    () => encodeDynamicHookStdout(event, {
      kind: "additionalContext",
      hookEventName: "SessionStart",
      additionalContext: "do not inject on compact",
    }),
    /PostCompact cannot emit additionalContext/u,
  );
});

test("PostCompact rejects a stop decision", () => {
  assert.throws(
    () => encodeDynamicHookStdout("PostCompact", { kind: "stopBlock", reason: "no" }),
    /PostCompact cannot emit a stop decision/u,
  );
});

test("unknown hook names ingest with empty stdout and cannot emit context", () => {
  assert.equal(parseCodexHookName("Note"), undefined);
  assert.equal(encodeDynamicHookStdout("Note", { kind: "empty" }), "");
  assert.throws(
    () => encodeDynamicHookStdout("Note", {
      kind: "additionalContext",
      hookEventName: "SessionStart",
      additionalContext: "no",
    }),
    /not a Codex hook and cannot emit stdout/u,
  );
});

test("SessionStart additionalContext and Stop block stay representable", () => {
  const context = encodeHookStdout("SessionStart", {
    kind: "additionalContext",
    hookEventName: "SessionStart",
    additionalContext: "pack",
  });
  assert.match(context, /hookSpecificOutput/u);
  assert.match(context, /"hookEventName":"SessionStart"/u);
  const stop = encodeHookStdout("Stop", { kind: "stopBlock", reason: "call lcm_pack_context" });
  assert.equal(JSON.parse(stop).decision, "block");
});

// Typechecked, but not executed: invalid literal calls must not find a fallback signature.
function assertLiteralConstraints(dynamicEvent: string, contextEvent: ContextCapableHook): void {
  // @ts-expect-error PostCompact cannot emit a stop decision (review finding 1).
  encodeHookStdout("PostCompact", { kind: "stopBlock", reason: "no" });
  // @ts-expect-error PostCompact cannot emit context.
  encodeHookStdout("PostCompact", { kind: "additionalContext", hookEventName: "SessionStart", additionalContext: "no" });
  // @ts-expect-error Stop cannot emit context.
  encodeHookStdout("Stop", { kind: "additionalContext", hookEventName: "SessionStart", additionalContext: "no" });
  // @ts-expect-error Context-capable hooks cannot emit stop decisions.
  encodeHookStdout("SessionStart", { kind: "stopBlock", reason: "no" });
  // @ts-expect-error Context must belong to the encoded event (review finding 2).
  encodeHookStdout("SessionStart", { kind: "additionalContext", hookEventName: "PostToolUse", additionalContext: "no" });
  // @ts-expect-error A union event does not prove that the context belongs to it.
  encodeHookStdout(contextEvent, { kind: "additionalContext", hookEventName: "SessionStart", additionalContext: "no" });
  // @ts-expect-error Dynamic strings must use the runtime-validated API.
  encodeHookStdout(dynamicEvent, { kind: "empty" });
}

const contextEvents = ["SessionStart", "UserPromptSubmit", "PostToolUse"] as const;
const outputs: readonly HookStdout[] = [
  { kind: "empty" },
  { kind: "stopBlock", reason: "no" },
  ...contextEvents.map((hookEventName) => ({
    kind: "additionalContext" as const,
    hookEventName,
    additionalContext: "pack",
  })),
];

for (const event of CODEX_HOOK_NAMES) {
  for (const stdout of outputs) {
    const contextEvent = stdout.kind === "additionalContext" ? stdout.hookEventName : undefined;
    test(`${event} validates ${stdout.kind}${contextEvent ? ` for ${contextEvent}` : ""}`, () => {
      if (stdout.kind === "empty") {
        assert.equal(encodeDynamicHookStdout(event, stdout), "");
      } else if (stdout.kind === "stopBlock") {
        if (event === "Stop") {
          assert.equal(encodeHookStdout(event, stdout), encodeDynamicHookStdout(event, stdout));
          assert.deepEqual(JSON.parse(encodeDynamicHookStdout(event, stdout)), { decision: "block", reason: stdout.reason });
        } else {
          assert.throws(() => encodeDynamicHookStdout(event, stdout), /cannot emit a stop decision/u);
        }
      } else if (!(contextEvents as readonly string[]).includes(event)) {
        assert.throws(() => encodeDynamicHookStdout(event, stdout), /cannot emit additionalContext/u);
      } else if (event !== stdout.hookEventName) {
        assert.throws(() => encodeDynamicHookStdout(event, stdout), /cannot emit additionalContext for/u);
      } else {
        assert.deepEqual(JSON.parse(encodeDynamicHookStdout(event, stdout)), {
          hookSpecificOutput: { hookEventName: event, additionalContext: stdout.additionalContext },
        });
      }
    });
  }
}
