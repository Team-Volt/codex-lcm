import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("Codex plugin manifest points to MCP and skills", () => {
  const manifest = JSON.parse(fs.readFileSync(".codex-plugin/plugin.json", "utf8"));

  assert.equal(manifest.name, "codex-lcm");
  assert.equal(manifest.license, "MIT");
  assert.equal(manifest.author.name, "Team Volt");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.hooks, "./hooks/hooks.codex.json");
  assert.equal(manifest.skills, "./skills/");
  assert.equal(manifest.interface.displayName, "Codex LCM");
  assert.equal(manifest.interface.developerName, "Team Volt");
});

test("package and repository declare the MIT license", () => {
  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const packageLicense = fs.readFileSync("LICENSE", "utf8");
  const repositoryLicense = fs.readFileSync("../../LICENSE", "utf8");

  assert.equal(packageJson.license, "MIT");
  assert.equal(packageJson.author, "Team Volt");
  assert.equal(packageLicense, repositoryLicense);
  assert.match(packageLicense, /^MIT License$/mu);
  assert.match(packageLicense, /^Copyright \(c\) 2026 Team Volt$/mu);
});

test("plugin includes a compact skill with routable frontmatter", () => {
  const skill = fs.readFileSync("skills/lcm-recall/SKILL.md", "utf8");
  const frontmatterEnd = skill.indexOf("\n---\n", 4);

  assert.notEqual(frontmatterEnd, -1);
  const frontmatter = skill.slice(0, frontmatterEnd + 5);
  assert.match(frontmatter, /^---\n/mu);
  assert.match(frontmatter, /^name: lcm-recall$/mu);
  assert.match(frontmatter, /^description: \S/mu);
  assert.match(frontmatter, /session memory/u);
  assert.match(frontmatter, /prior decisions/u);
  assert.match(frontmatter, /project preferences/u);
  assert.match(frontmatter, /projectless sessions/u);
  assert.equal(Buffer.byteLength(skill, "utf8") <= 6_000, true);
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
  const events = [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "SubagentStop",
    "Stop",
  ];

  assert.deepEqual(Object.keys(manifest.hooks), events);
  for (const event of events) {
    const command = manifest.hooks[event][0].hooks[0].command;
    assert.match(command, /\$\{PLUGIN_ROOT\}/u);
    assert.doesNotMatch(command, /CLAUDE_PLUGIN_ROOT/u);
    assert.match(command, new RegExp(`codex-lcm" hook ${event}`, "u"));
  }
});

test("marketplace entry installs the repository plugin root", () => {
  const marketplace = JSON.parse(fs.readFileSync("../../.agents/plugins/marketplace.json", "utf8"));

  assert.equal(marketplace.name, "codex-lcm");
  assert.equal(marketplace.plugins[0].name, "codex-lcm");
  assert.deepEqual(marketplace.plugins[0].source, { source: "local", path: "./plugins/codex-lcm" });
  assert.equal(marketplace.plugins[0].policy.installation, "AVAILABLE");
  assert.equal(marketplace.plugins[0].policy.authentication, "ON_INSTALL");
});
