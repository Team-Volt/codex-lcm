import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeForStorage } from "../src/redact.ts";

test("redacts secret-like object keys recursively", () => {
  const result = sanitizeForStorage({
    nested: {
      api_key: "sk-proj-secret-value",
      normal: "visible",
      password: "hunter2",
    },
  });

  assert.deepEqual(result.value, {
    nested: {
      api_key: "[REDACTED:secret]",
      normal: "visible",
      password: "[REDACTED:secret]",
    },
  });
  assert.equal(result.redactions.length, 2);
  assert.equal(result.truncations.length, 0);
});

test("redacts obvious bearer and provider tokens inside strings", () => {
  const result = sanitizeForStorage({
    text: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789 and ghp_abcdefghijklmnopqrstuvwxyz012345",
  });

  const text = (result.value as { text: string }).text;
  assert.match(text, /Authorization: Bearer \[REDACTED:token\]/u);
  assert.match(text, /ghp_\[REDACTED:token\]/u);
  assert.equal(result.redactions.length, 2);
});

test("truncates oversized string values with hash metadata", () => {
  const result = sanitizeForStorage({ content: "a".repeat(128) }, { maxStringBytes: 32 });

  const value = result.value as { content: unknown };
  assert.deepEqual(value.content, {
    lcm_truncated: true,
    kind: "string",
    original_bytes: 128,
    sha256: "6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e",
    preview: "a".repeat(32),
  });
  assert.equal(result.truncations.length, 1);
});

test("truncated previews respect byte limits for multibyte text", () => {
  const result = sanitizeForStorage({ content: "水".repeat(20) }, { maxStringBytes: 10 });
  const content = (result.value as { content: { preview: string } }).content;

  assert.equal(Buffer.byteLength(content.preview, "utf8") <= 10, true);
});

test("payload truncation previews respect byte limits for multibyte text", () => {
  const result = sanitizeForStorage(
    { content: "水".repeat(20) },
    { maxStringBytes: 1_000, maxPayloadBytes: 20 },
  );
  const value = result.value as { preview: string };

  assert.equal(Buffer.byteLength(value.preview, "utf8") <= 20, true);
});
