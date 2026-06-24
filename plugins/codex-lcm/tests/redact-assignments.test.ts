import assert from "node:assert/strict";
import test from "node:test";

import { sanitizeForStorage } from "../src/redact.ts";

test("redacts compact dotted and plural secret assignment keys", () => {
  const result = sanitizeForStorage({
    text: [
      "apikey=compact-secret-value",
      "SECRETKEY=compact-secret-key",
      "openai.api_key=dotted-secret-value",
      "config.authorization=Basic dXNlcjpwYXNz",
      "tokens=plural-secret-value",
      "tokens_budget=not-a-number-secret",
    ].join("\n"),
  });

  const text = (result.value as { text: string }).text;
  assert.match(text, /apikey=\[REDACTED:secret\]/u);
  assert.match(text, /SECRETKEY=\[REDACTED:secret\]/u);
  assert.match(text, /openai\.api_key=\[REDACTED:secret\]/u);
  assert.match(text, /config\.authorization=\[REDACTED:secret\]/u);
  assert.match(text, /tokens=\[REDACTED:secret\]/u);
  assert.match(text, /tokens_budget=\[REDACTED:secret\]/u);
  assert.doesNotMatch(text, /compact-secret|dotted-secret|dXNlcjpwYXNz|plural-secret|not-a-number-secret/u);
  assert.equal(result.redactions.length, 6);
});

test("redacts nonnumeric structured token metric fields", () => {
  const result = sanitizeForStorage({
    token_budget: 1200,
    tokens_budget: "not-a-number-secret",
    tokens_used: "also-secret",
    openai: {
      api_key: "nested-secret",
    },
    SECRETKEY: "compact-secret-key",
  });

  assert.deepEqual(result.value, {
    token_budget: 1200,
    tokens_budget: "[REDACTED:secret]",
    tokens_used: "[REDACTED:secret]",
    openai: {
      api_key: "[REDACTED:secret]",
    },
    SECRETKEY: "[REDACTED:secret]",
  });
  assert.equal(result.redactions.length, 4);
});

test("redacts secret fields inside JSON-like assignments behind labels", () => {
  const result = sanitizeForStorage({
    text: [
      'payload={"token":"hidden-token-value","token_budget":1200}',
      'other={"api_key":"hidden-api-value","tokens_used":374}',
    ].join("\n"),
  });

  const text = (result.value as { text: string }).text;
  assert.match(text, /payload=\{"token":"\[REDACTED:secret\]","token_budget":1200\}/u);
  assert.match(text, /other=\{"api_key":"\[REDACTED:secret\]","tokens_used":374\}/u);
  assert.doesNotMatch(text, /hidden-token-value|hidden-api-value/u);
  assert.equal(result.redactions.length, 2);
});

test("preserves sentence-final token metric assignments", () => {
  const result = sanitizeForStorage({
    text: "metrics ended with punctuation: token_budget=1200. auto_compact_token_limit=150000.",
  });

  const text = (result.value as { text: string }).text;
  assert.match(text, /token_budget=1200\./u);
  assert.match(text, /auto_compact_token_limit=150000\./u);
  assert.equal(result.redactions.length, 0);
});
