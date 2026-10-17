import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_HOST,
  encodeHookStdout,
  parseCodexHookName,
} from "../src/host-profile.ts";

test("PostCompact is typed as empty stdout and encodes to an empty string", () => {
  assert.equal(CODEX_HOST.hooks.PostCompact.stdout, "empty");
  assert.equal(encodeHookStdout("PostCompact", { kind: "empty" }), "");
});

test("PostCompact rejects additionalContext at the encoder boundary", () => {
  const event: string = "PostCompact";
  assert.throws(
    () => encodeHookStdout(event, {
      kind: "additionalContext",
      hookEventName: "SessionStart",
      additionalContext: "do not inject on compact",
    }),
    /PostCompact cannot emit additionalContext/u,
  );
});

test("PostCompact rejects a stop decision", () => {
  assert.throws(
    () => encodeHookStdout("PostCompact", { kind: "stopBlock", reason: "no" }),
    /PostCompact cannot emit a stop decision/u,
  );
});

test("unknown hook names ingest with empty stdout and cannot emit context", () => {
  assert.equal(parseCodexHookName("Note"), undefined);
  assert.equal(encodeHookStdout("Note", { kind: "empty" }), "");
  assert.throws(
    () => encodeHookStdout("Note", {
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
