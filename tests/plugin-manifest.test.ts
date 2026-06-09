import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Codex plugin manifest points to MCP and hook manifests", () => {
  const manifest = JSON.parse(fs.readFileSync(".codex-plugin/plugin.json", "utf8"));

  assert.equal(manifest.name, "codex-lcm");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.hooks, "./hooks/hooks.codex.json");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.displayName, "Codex LCM");
});

test("plugin includes a Codex skill that nudges agents to use LCM", () => {
  const skill = fs.readFileSync("skills/lcm-recall/SKILL.md", "utf8");

  assert.match(skill, /^---\nname: lcm-recall/mu);
  assert.match(skill, /lcm_search_sessions/u);
  assert.match(skill, /lcm_pack_context/u);
});

test("MCP manifest registers the local stdio server", () => {
  const manifest = JSON.parse(fs.readFileSync(".mcp.json", "utf8"));

  assert.deepEqual(manifest.mcpServers["codex-lcm"], {
    cwd: ".",
    command: "node",
    args: ["./bin/codex-lcm", "mcp"],
  });
});

test("hook manifest registers all required Codex lifecycle hooks", () => {
  const manifest = JSON.parse(fs.readFileSync("hooks/hooks.codex.json", "utf8"));
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"];

  assert.deepEqual(Object.keys(manifest.hooks), events);
  for (const event of events) {
    const command = manifest.hooks[event][0].hooks[0].command;
    assert.match(command, new RegExp(`codex-lcm" hook ${event}`, "u"));
  }
});
