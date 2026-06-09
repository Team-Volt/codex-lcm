import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { assertCliOk, runCli, tempHome } from "./helpers.ts";

test("install dry-run reports MCP and hook wiring without modifying Codex home", () => {
  const codexHome = tempHome();
  const result = runCli(["install", "--dry-run", "--codex-home", codexHome, "--json"]);

  assertCliOk(result);
  const planned = JSON.parse(result.stdout);
  assert.equal(planned.mode, "dry-run");
  assert.match(planned.mcp.command, /codex mcp add codex-lcm -- node /u);
  assert.match(planned.skills.path, /skills$/u);
  assert.match(planned.skills.recall_skill, /lcm-recall\/SKILL\.md$/u);
  assert.equal(planned.hooks.SessionStart[0].hooks[0].type, "command");
  assert.match(planned.hooks.SessionStart[0].hooks[0].command, /codex-lcm" hook SessionStart/u);
  assert.equal(fs.existsSync(path.join(codexHome, "hooks.json")), false);
});

test("uninstall dry-run reports removal plan without modifying Codex home", () => {
  const codexHome = tempHome();
  fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: {} }, null, 2));

  const result = runCli(["uninstall", "--dry-run", "--codex-home", codexHome, "--json"]);

  assertCliOk(result);
  const planned = JSON.parse(result.stdout);
  assert.equal(planned.mode, "dry-run");
  assert.equal(planned.mcp.command, "codex mcp remove codex-lcm");
  assert.equal(planned.hook_command_match, "codex-lcm");
  assert.equal(JSON.parse(fs.readFileSync(path.join(codexHome, "hooks.json"), "utf8")).hooks !== undefined, true);
});

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
  assert.equal(status.mcp_configured, false);
  assert.equal(status.hooks_configured, false);
  assert.equal(status.recall_skill_available, true);
});
