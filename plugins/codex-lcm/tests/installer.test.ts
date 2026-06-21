import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertCliOk, runCli, tempHome } from "./helpers.ts";

test("status reads Codex home and reports absent wiring", () => {
  const codexHome = tempHome();
  fs.writeFileSync(path.join(codexHome, "config.toml"), "[features]\nhooks = true\n");
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: {} }, null, 2));

  const result = runCli(["status", "--codex-home", codexHome, "--json"]);

  assertCliOk(result);
  const status = JSON.parse(result.stdout);
  assert.equal(status.codex_home, codexHome);
  assert.equal(status.config_exists, true);
  assert.equal(status.hooks_json_exists, true);
  assert.equal(status.marketplace_configured, false);
  assert.equal(status.plugin_configured, false);
  assert.equal(status.plugin_manifest_available, true);
  assert.equal(status.plugin_declares_mcp, true);
  assert.equal(status.plugin_declares_hooks, true);
  assert.equal(status.mcp_manifest_available, true);
  assert.equal(status.hook_manifest_available, true);
  assert.equal(status.manual_mcp_configured, false);
  assert.equal(status.manual_hooks_configured, false);
  assert.equal(status.mcp_configured, false);
  assert.equal(status.hooks_configured, false);
  assert.equal(status.recall_skill_available, true);
});

test("status recognizes Codex-native plugin wiring", () => {
  const codexHome = tempHome();
  fs.writeFileSync(
    path.join(codexHome, "config.toml"),
    [
      "[marketplaces.codex-lcm]",
      'source_type = "local"',
      `source = ${JSON.stringify(path.resolve("../.."))}`,
      "",
      "[plugins.\"codex-lcm@codex-lcm\"]",
      "enabled = true",
      'path = "/tmp/codex-lcm"',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: {} }, null, 2));

  const result = runCli(["status", "--codex-home", codexHome, "--json"]);

  assertCliOk(result);
  const status = JSON.parse(result.stdout);
  assert.equal(status.marketplace_configured, true);
  assert.equal(status.plugin_configured, true);
  assert.equal(status.plugin_manifest_available, true);
  assert.equal(status.plugin_declares_mcp, true);
  assert.equal(status.plugin_declares_hooks, true);
  assert.equal(status.mcp_manifest_available, true);
  assert.equal(status.hook_manifest_available, true);
  assert.equal(status.manual_mcp_configured, false);
  assert.equal(status.manual_hooks_configured, false);
  assert.equal(status.mcp_configured, true);
  assert.equal(status.hooks_configured, true);
  assert.equal(status.recall_skill_available, true);
});
