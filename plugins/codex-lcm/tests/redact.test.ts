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

test("preserves benign token budget and count metadata", () => {
  const result = sanitizeForStorage({
    token_budget: 1200,
    tokens_budget: 1200,
    tokens_used: 374,
    auto_compact_token_limit: 100000,
    token_count: 42,
    token: "sk-proj-secret-value",
  });

  assert.deepEqual(result.value, {
    token_budget: 1200,
    tokens_budget: 1200,
    tokens_used: 374,
    auto_compact_token_limit: 100000,
    token_count: 42,
    token: "[REDACTED:secret]",
  });
  assert.equal(result.redactions.length, 1);
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
      "authorization=Bearer abc12345",
      "authorization=Basic dXNlcjpwYXNz",
      "authToken=Bearer abcdefghijklmnopqrstuvwxyz0123456789",
      '"DATABASE_URL":"postgres://user:password@localhost:5432/app"',
      "PRIVATE_KEY=-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----",
    ].join("\n"),
  });

  const env = (result.value as { env: string }).env;
  assert.match(env, /authToken=\[REDACTED:secret\]/u);
  assert.match(env, /accessToken: \[REDACTED:secret\]/u);
  assert.match(env, /refresh_token = \[REDACTED:secret\]/u);
  assert.match(env, /sessionCookie=\[REDACTED:secret\]/u);
  assert.match(env, /authorization=Bearer \[REDACTED:token\]/u);
  assert.match(env, /authorization=\[REDACTED:secret\]/u);
  assert.match(env, /authToken=Bearer \[REDACTED:token\]/u);
  assert.match(env, /"DATABASE_URL":"\[REDACTED:secret\]"/u);
  assert.match(env, /PRIVATE_KEY=\[REDACTED:secret\]/u);
  assert.doesNotMatch(env, /tok_123456789|abc12345|dXNlcjpwYXNz|abcdefghijklmnopqrstuvwxyz0123456789|password@localhost|BEGIN PRIVATE KEY/u);
  assert.equal(result.redactions.length, 9);
});

test("preserves benign numeric token metadata inside JSON-like text", () => {
  const result = sanitizeForStorage({
    text: [
      '"token_budget": 1200,',
      '"tokens_budget": 1200,',
      '"tokens_used": 374,',
      '"auto_compact_token_limit": 100000,',
      '"token_count": 42,',
      '"token": "sk-proj-secret-value",',
      '"authorization": "Bearer fake-secret"',
    ].join("\n"),
  });

  if (typeof result.value !== "object" || result.value === null || !("text" in result.value) || typeof result.value.text !== "string") {
    assert.fail("expected sanitized value to contain text");
  }
  const text = result.value.text;
  assert.match(text, /"token_budget": 1200,/u);
  assert.match(text, /"tokens_budget": 1200,/u);
  assert.match(text, /"tokens_used": 374,/u);
  assert.match(text, /"auto_compact_token_limit": 100000,/u);
  assert.match(text, /"token_count": 42,/u);
  assert.match(text, /"token": "\[REDACTED:secret\]"/u);
  assert.match(text, /"authorization": "Bearer \[REDACTED:token\]"/u);
  assert.doesNotMatch(text, /sk-proj-secret-value|fake-secret/u);
  assert.equal(result.redactions.length, 2);
});

test("preserves benign token metric prose while redacting later fake secrets", () => {
  const result = sanitizeForStorage({
    text: [
      "lcm-token-metrics-smoke-20260624-1720 benign metrics:",
      "token_budget=1200 tokens_budget=1300 tokens_used=374 token_count=148 auto_compact_token_limit=150000",
      'json={"token_budget":1200,"tokens_budget":1300,"tokens_used":374,"token_count":148,"auto_compact_token_limit":150000}.',
      "fake secrets: Authorization: Bearer abc123 fakeAuth=Bearer abc1234567890abcdef longBearer=Bearer abcdefghijklmnopqrstuvwxyz0123456789._~+/=- provider=sk-proj-testvalue_abcdefghijklmnopqrstuvwxyz1234567890",
    ].join(" "),
  });

  if (typeof result.value !== "object" || result.value === null || !("text" in result.value) || typeof result.value.text !== "string") {
    assert.fail("expected sanitized value to contain text");
  }
  const text = result.value.text;
  assert.match(text, /token_budget=1200/u);
  assert.match(text, /tokens_budget=1300/u);
  assert.match(text, /tokens_used=374/u);
  assert.match(text, /token_count=148/u);
  assert.match(text, /auto_compact_token_limit=150000/u);
  assert.match(text, /"token_budget":1200/u);
  assert.match(text, /Authorization: Bearer \[REDACTED:token\]/u);
  assert.match(text, /fakeAuth=Bearer \[REDACTED:token\]/u);
  assert.match(text, /longBearer=Bearer \[REDACTED:token\]/u);
  assert.match(text, /provider=sk-proj_\[REDACTED:token\]/u);
  assert.doesNotMatch(text, /abc123|abcdefghijklmnopqrstuvwxyz1234567890|abcdefghijklmnopqrstuvwxyz0123456789/u);
  assert.doesNotMatch(text, /benign metrics: \[REDACTED:secret\]/u);
});

test("preserves token metric JSON assignment while redacting later fake secrets", () => {
  const result = sanitizeForStorage({
    text: 'lcm-token-metrics-json-smoke-20260624-1721 metrics_json={"token_budget":1200,"tokens_budget":1300,"tokens_used":374,"token_count":148,"auto_compact_token_limit":150000}; fake secrets follow: Authorization: Bearer abc123 fakeAuth=Bearer abc1234567890abcdef provider=sk-proj-testvalue_abcdefghijklmnopqrstuvwxyz1234567890',
  });

  if (typeof result.value !== "object" || result.value === null || !("text" in result.value) || typeof result.value.text !== "string") {
    assert.fail("expected sanitized value to contain text");
  }
  const text = result.value.text;
  assert.match(text, /metrics_json=\{"token_budget":1200/u);
  assert.match(text, /"tokens_budget":1300/u);
  assert.match(text, /"tokens_used":374/u);
  assert.match(text, /"token_count":148/u);
  assert.match(text, /"auto_compact_token_limit":150000/u);
  assert.match(text, /Authorization: Bearer \[REDACTED:token\]/u);
  assert.match(text, /fakeAuth=Bearer \[REDACTED:token\]/u);
  assert.match(text, /provider=sk-proj_\[REDACTED:token\]/u);
  assert.doesNotMatch(text, /abc123|abcdefghijklmnopqrstuvwxyz1234567890/u);
  assert.doesNotMatch(text, /metrics_json=\[REDACTED:secret\]/u);
});

test("redacts bearer token contents regardless of token length", () => {
  const result = sanitizeForStorage({
    short: "Authorization: Bearer abc123",
    long: `curl -H "Authorization: Bearer ${"a".repeat(256)}" https://example.test`,
  });

  assert.equal((result.value as { short: string }).short, "Authorization: Bearer [REDACTED:token]");
  assert.equal(
    (result.value as { long: string }).long,
    `curl -H "Authorization: Bearer [REDACTED:token]" https://example.test`,
  );
  assert.doesNotMatch(JSON.stringify(result.value), /abc123|aaaaaaaa/u);
  assert.equal(result.redactions.length, 2);
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
