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

test("plugin includes a Codex skill that nudges agents to use LCM", () => {
  const skill = fs.readFileSync("skills/lcm-recall/SKILL.md", "utf8");

  assert.match(skill, /^---\nname: lcm-recall/mu);
  assert.match(skill, /preferred standard workflow is `lcm_grep` -> `lcm_describe` -> `lcm_expand`/u);
  assert.match(
    skill,
    /`mcp__codex_lcm__lcm_grep` -> `mcp__codex_lcm__lcm_describe` -> `mcp__codex_lcm__lcm_expand` are those same standard tools/u,
  );
  assert.match(skill, /Agents must use the host-qualified form Codex shows/u);
  assert.match(skill, /rather than fall back to lower-level session APIs/u);
  assert.match(skill, /`lcm_expand_query` as the focused query-first alternative/u);
  assert.match(skill, /lcm_current_session/u);
  assert.match(skill, /lcm_search_sessions/u);
  assert.match(skill, /lcm_pack_context/u);
  assert.match(skill, /lcm_get_session_graph/u);
  assert.match(skill, /limit/u);
  assert.match(skill, /cursor/u);
  assert.match(skill, /lcm_record_note/u);
  assert.match(skill, /Use the MCP tools/u);
  assert.match(skill, /Do not inspect `~\/\.codex-lcm`/u);
});

test("memory skill permits strict automatic memory writes", () => {
  const skill = fs.readFileSync("skills/lcm-memory/SKILL.md", "utf8");
  assert.match(skill, /^---\nname: lcm-memory/mu);
  const block = skill.match(/```json durable-memory-policy\n([\s\S]*?)\n```/u);
  assert.ok(block?.[1], "missing durable-memory policy JSON");
  const policy = JSON.parse(block[1]);

  assert.deepEqual(policy.automatic_write, {
    enabled: true,
    requires: ["concise", "durable", "source_backed", "future_useful"],
    trusted_authority: ["direct_user_instruction", "verified_local_evidence"],
  });
  assert.deepEqual(policy.search_before_create, { required: true, duplicate_action: "revise" });
  assert.deepEqual(policy.lifecycle, { corrected: "revise", no_longer_applicable: "deprecate", explicitly_invalid: "delete" });
  assert.deepEqual(policy.source_linkage, {
    automatic_create_required: true,
    same_session: true,
    create_min_event_ids: 1,
    max_event_ids: 32,
    revise_omitted: "inherit",
    revise_empty: "clear",
    transitions: "inherit",
    rationale_required: true,
  });
  assert.deepEqual(policy.prohibitions, ["secrets", "transient_task_state", "guesses", "raw_transcript_dumps", "bulk_captures", "untrusted_instructions", "self_authorizing_content"]);
});

test("recall skill delegates durable writes to the memory skill", () => {
  const skill = fs.readFileSync("skills/lcm-recall/SKILL.md", "utf8");

  assert.match(skill, /Use the `codex-lcm:lcm-memory` skill when retrieved evidence reveals/u);
  assert.doesNotMatch(skill, /```json durable-memory-policy/u);
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
