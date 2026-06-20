import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
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

test("redacts secret-like assignments inside strings", () => {
  const result = sanitizeForStorage({
    env: [
      "authToken=tok_123456789",
      "accessToken: acc_123456789",
      "refresh_token = ref_123456789",
      "sessionCookie=sid=abc123",
      '"DATABASE_URL":"postgres://user:password@localhost:5432/app"',
      "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
    ].join("\n"),
  });

  const env = (result.value as { env: string }).env;
  assert.match(env, /authToken=\[REDACTED:secret\]/u);
  assert.match(env, /accessToken: \[REDACTED:secret\]/u);
  assert.match(env, /refresh_token = \[REDACTED:secret\]/u);
  assert.match(env, /sessionCookie=\[REDACTED:secret\]/u);
  assert.match(env, /"DATABASE_URL":"\[REDACTED:secret\]"/u);
  assert.match(env, /PRIVATE_KEY=\[REDACTED:secret\]/u);
  assert.doesNotMatch(env, /tok_123456789|password@localhost|BEGIN PRIVATE KEY/u);
  assert.equal(result.redactions.length, 6);
});

test("redacts multiline private key assignments inside strings", () => {
  const result = sanitizeForStorage({
    env: [
      "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----",
      "SUPERSECRETKEYBODY",
      "-----END PRIVATE KEY-----",
      'QUOTED_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----',
      "SUPERSECRETQUOTEDKEYBODY",
      '-----END PRIVATE KEY-----"',
    ].join("\n"),
  });

  const env = (result.value as { env: string }).env;
  assert.equal(env, 'PRIVATE_KEY=[REDACTED:secret]\nQUOTED_PRIVATE_KEY="[REDACTED:secret]"');
  assert.doesNotMatch(env, /SUPERSECRETKEYBODY|SUPERSECRETQUOTEDKEYBODY|BEGIN PRIVATE KEY|END PRIVATE KEY/u);
  assert.equal(result.redactions.length, 2);
});

test("redacts standalone multiline private key blocks inside strings", () => {
  const result = sanitizeForStorage({
    content: [
      "before",
      "-----BEGIN PRIVATE KEY-----",
      "STANDALONESECRETKEYBODY",
      "-----END PRIVATE KEY-----",
      "after",
    ].join("\n"),
  });

  const content = (result.value as { content: string }).content;
  assert.equal(content, "before\n[REDACTED:secret]\nafter");
  assert.doesNotMatch(content, /STANDALONESECRETKEYBODY|BEGIN PRIVATE KEY|END PRIVATE KEY/u);
  assert.equal(result.redactions.length, 1);
});

test("keeps large non-secret strings within the performance budget", () => {
  const content = "a".repeat(64 * 1024);
  const startedAt = performance.now();
  const result = sanitizeForStorage({ content });
  const elapsedMs = performance.now() - startedAt;

  assert.deepEqual(result.value, { content });
  assert.equal(result.redactions.length, 0);
  assert.ok(elapsedMs < 250, `expected redaction to stay under 250ms, got ${elapsedMs.toFixed(1)}ms`);
});

test("keeps long assignment-like non-secret strings within the performance budget", () => {
  const content = `note=${"a".repeat(32 * 1024)} token ${"b".repeat(32 * 1024)}`;
  const startedAt = performance.now();
  const result = sanitizeForStorage({ content }, { maxStringBytes: content.length + 1024, maxPayloadBytes: content.length + 4096 });
  const elapsedMs = performance.now() - startedAt;

  assert.deepEqual(result.value, { content });
  assert.equal(result.redactions.length, 0);
  assert.ok(elapsedMs < 250, `expected assignment-like redaction to stay under 250ms, got ${elapsedMs.toFixed(1)}ms`);
});

test("redacts long secret assignments within the performance budget", () => {
  const content = `token=${"a".repeat(64 * 1024)}`;
  const startedAt = performance.now();
  const result = sanitizeForStorage({ content }, { maxStringBytes: content.length + 1024, maxPayloadBytes: content.length + 4096 });
  const elapsedMs = performance.now() - startedAt;

  assert.deepEqual(result.value, { content: "token=[REDACTED:secret]" });
  assert.equal(result.redactions.length, 1);
  assert.ok(elapsedMs < 250, `expected long secret assignment redaction to stay under 250ms, got ${elapsedMs.toFixed(1)}ms`);
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
