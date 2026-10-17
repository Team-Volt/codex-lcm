import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { importCodexSessions } from "../src/codex-import.ts";
import { classifySessionFile, SESSION_SOURCE_KINDS } from "../src/session-source.ts";
import { createStorage } from "../src/storage.ts";
import { tempHome } from "./helpers.ts";

test("classifies the four historical Codex session source kinds", () => {
  const dir = writeCorpus();
  const classified = {
    "uuid-rollout": classifySessionFile(path.join(dir, "rollout-2026-07-09T14-41-58-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl")),
    "current-codex-record": classifySessionFile(path.join(dir, "current.jsonl")),
    "subagent-transcript": classifySessionFile(path.join(dir, "subagent.jsonl")),
    "forked-rollout-with-lineage": classifySessionFile(path.join(dir, "lineage.jsonl")),
  };

  assert.deepEqual(classified["uuid-rollout"].kinds, ["uuid-rollout"]);
  assert.equal(classified["uuid-rollout"].unclassified, false);
  assert.deepEqual(classified["current-codex-record"].kinds, ["current-codex-record"]);
  assert.deepEqual(classified["subagent-transcript"].kinds, ["subagent-transcript"]);
  assert.deepEqual(classified["forked-rollout-with-lineage"].kinds, ["forked-rollout-with-lineage"]);
});

test("live import counts unclassified files and does not throw", async () => {
  const dir = tempHome("session-source-live-");
  fs.writeFileSync(path.join(dir, "notes.jsonl"), `${JSON.stringify({ note: "not a session" })}\n`);
  const storage = createStorage({ home: tempHome("session-source-live-home-") });
  try {
    const report = await importCodexSessions(storage, { from: dir });
    assert.equal(report.files_unclassified, 1);
    assert.equal(report.events_imported, 0);
  } finally {
    storage.close();
  }
});

test("requireClassified fails live-looking junk only when requested", async () => {
  const dir = tempHome("session-source-strict-");
  fs.writeFileSync(path.join(dir, "notes.jsonl"), `${JSON.stringify({ note: "not a session" })}\n`);
  const storage = createStorage({ home: tempHome("session-source-strict-home-") });
  try {
    await assert.rejects(
      importCodexSessions(storage, { from: dir, requireClassified: true }),
      /unclassified session file/u,
    );
  } finally {
    storage.close();
  }
});

test("requireKinds fails a fixture corpus that omits a historical source", async () => {
  const dir = tempHome("session-source-kinds-");
  fs.writeFileSync(
    path.join(dir, "current.jsonl"),
    `${JSON.stringify({ timestamp: "2026-06-18T12:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] } })}\n`,
  );
  const storage = createStorage({ home: tempHome("session-source-kinds-home-") });
  try {
    await assert.rejects(
      importCodexSessions(storage, { from: dir, requireKinds: SESSION_SOURCE_KINDS }),
      /missing session source kinds: uuid-rollout, subagent-transcript, forked-rollout-with-lineage/u,
    );
  } finally {
    storage.close();
  }
});

test("requireKinds accepts a corpus that covers every historical source", async () => {
  const dir = writeCorpus();
  const storage = createStorage({ home: tempHome("session-source-corpus-home-") });
  try {
    const report = await importCodexSessions(storage, { from: dir, requireKinds: SESSION_SOURCE_KINDS });
    assert.equal(report.files_unclassified, 0);
    assert.equal(report.files_by_source["uuid-rollout"] > 0, true);
    assert.equal(report.files_by_source["current-codex-record"] > 0, true);
    assert.equal(report.files_by_source["subagent-transcript"] > 0, true);
    assert.equal(report.files_by_source["forked-rollout-with-lineage"] > 0, true);
  } finally {
    storage.close();
  }
});

for (const uuidNamed of [false, true]) {
  test(`large metadata and later records retain overlapping kinds (UUID filename: ${uuidNamed})`, async () => {
    const dir = tempHome("session-source-large-");
    const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const file = path.join(dir, uuidNamed ? `rollout-2026-07-09T14-41-58-${uuid}.jsonl` : "large.jsonl");
    const metadata = {
      timestamp: "2026-07-09T18:41:58.000Z",
      type: "session_meta",
      payload: {
        id: uuid,
        instructions: "x".repeat(128 * 1024),
        source: { subagent: {} },
        parent_thread_id: "parent",
      },
    };
    const response = {
      timestamp: "2026-07-09T18:41:59.000Z",
      type: "response_item",
      payload: { type: "message", role: "user", content: [{ type: "input_text", text: "after large header" }] },
    };
    // CRLF metadata plus an unterminated final record exercise both line endings.
    fs.writeFileSync(file, `${JSON.stringify(metadata)}\r\n${JSON.stringify(response)}`);
    const expected = SESSION_SOURCE_KINDS.filter((kind) => uuidNamed || kind !== "uuid-rollout");
    const classified = classifySessionFile(file);
    assert.deepEqual(classified.kinds, expected);
    assert.equal(classified.unclassified, false);
    assert.equal(classified.reason, undefined);

    const storage = createStorage({ home: tempHome("session-source-large-home-") });
    try {
      const report = await importCodexSessions(storage, { from: dir, requireKinds: expected, requireClassified: true });
      assert.equal(report.files_unclassified, 0);
      for (const kind of expected) assert.equal(report.files_by_source[kind], 1);
      assert.equal(report.events_imported, 2);
      assert.deepEqual(report.errors, []);
    } finally {
      storage.close();
    }
  });
}

for (const prefixBytes of [64 * 1024 - 1, 64 * 1024, 64 * 1024 + 1]) {
  test(`reads a source record around the old peek boundary (${prefixBytes} bytes)`, () => {
    const dir = tempHome("session-source-boundary-");
    const file = path.join(dir, "boundary.jsonl");
    const prefix = `${JSON.stringify({ padding: "" })}\n`;
    const header = `${JSON.stringify({ padding: "x".repeat(prefixBytes - Buffer.byteLength(prefix)) })}\n`;
    assert.equal(Buffer.byteLength(header), prefixBytes);
    fs.writeFileSync(file, `${header}${JSON.stringify({ type: "response_item" })}\n`);
    assert.deepEqual(classifySessionFile(file).kinds, ["current-codex-record"]);
  });
}

test("decodes UTF-8 spanning a read boundary before parsing the complete record", () => {
  const dir = tempHome("session-source-utf8-");
  const file = path.join(dir, "utf8.jsonl");
  const prefix = '{"type":"session_meta","payload":{"padding":"';
  fs.writeFileSync(file, `${prefix}${"x".repeat(64 * 1024 - Buffer.byteLength(prefix) - 1)}😀","source":{"subagent":{}}}}`);
  assert.deepEqual(classifySessionFile(file).kinds, ["subagent-transcript"]);
  assert.equal(classifySessionFile(file).reason, undefined);
});

test("retains UUID filename evidence for empty and unreadable files", () => {
  const dir = tempHome("session-source-fallback-");
  const file = path.join(dir, "rollout-2026-07-09T14-41-58-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.jsonl");
  fs.writeFileSync(file, "");
  assert.deepEqual(classifySessionFile(file), { path: file, kinds: ["uuid-rollout"], unclassified: false });
  // A missing path is a deterministic open failure even when tests run as root.
  fs.unlinkSync(file);
  const unreadable = classifySessionFile(file);
  assert.deepEqual(unreadable.kinds, ["uuid-rollout"]);
  assert.equal(unreadable.unclassified, false);
  assert.match(unreadable.reason ?? "", /ENOENT/u);
  const unknown = classifySessionFile(path.join(dir, "missing.jsonl"));
  assert.equal(unknown.unclassified, true);
  assert.deepEqual(unknown.kinds, []);
  assert.match(unknown.reason ?? "", /ENOENT/u);
});

test("malformed JSON preserves preceding metadata evidence and reports the physical line", () => {
  const dir = tempHome("session-source-malformed-");
  const file = path.join(dir, "malformed.jsonl");
  fs.writeFileSync(file, `\n${JSON.stringify({ type: "session_meta", payload: { source: { subagent: {} }, parent_thread_id: "parent" } })}\n{broken\n`);
  const classified = classifySessionFile(file);
  assert.deepEqual(classified.kinds, ["subagent-transcript", "forked-rollout-with-lineage"]);
  assert.equal(classified.unclassified, false);
  assert.equal(classified.reason, "invalid JSON on line 3 of malformed.jsonl");
  fs.writeFileSync(file, "{broken\n");
  assert.equal(classifySessionFile(file).unclassified, true);
  assert.equal(classifySessionFile(file).reason, "invalid JSON on line 1 of malformed.jsonl");
});

function writeCorpus(): string {
  const dir = tempHome("session-source-corpus-");
  const uuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  fs.writeFileSync(
    path.join(dir, `rollout-2026-07-09T14-41-58-${uuid}.jsonl`),
    `${JSON.stringify({ timestamp: "2026-07-09T18:41:58.000Z", type: "session_meta", payload: { id: uuid, cwd: "/tmp/uuid" } })}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "current.jsonl"),
    `${JSON.stringify({ timestamp: "2026-06-18T12:00:00.000Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "current" }] } })}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "subagent.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-07-14T14:00:00.000Z",
      type: "session_meta",
      payload: { id: "child", cwd: "/tmp/sub", source: { subagent: { thread_spawn: { parent_thread_id: "parent", depth: 1 } } } },
    })}\n`,
  );
  fs.writeFileSync(
    path.join(dir, "lineage.jsonl"),
    `${JSON.stringify({
      timestamp: "2026-07-14T14:00:00.000Z",
      type: "session_meta",
      payload: { id: "child-session", cwd: "/tmp/lineage", parent_thread_id: "parent-session" },
    })}\n`,
  );
  return dir;
}
