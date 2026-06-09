import fs from "node:fs";
import path from "node:path";

import { codexHome, pluginRoot } from "./config.ts";

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PreCompact", "Stop"];

export type InstallerOptions = {
  codexHome?: string;
  root?: string;
};

export function planInstall(options: InstallerOptions = {}) {
  const root = path.resolve(options.root ?? pluginRoot());
  const binPath = path.join(root, "bin", "codex-lcm");
  return {
    mode: "dry-run",
    plugin_root: root,
    skills: {
      path: path.join(root, "skills"),
      recall_skill: path.join(root, "skills", "lcm-recall", "SKILL.md"),
      note: "Loaded by native Codex plugin installation; this dry-run planner does not copy or install skills.",
    },
    mcp: {
      command: `codex mcp add codex-lcm -- node ${JSON.stringify(binPath)} mcp`,
    },
    hooks: buildHookConfig(root).hooks,
  };
}

export function planUninstall(_options: InstallerOptions = {}) {
  return {
    mode: "dry-run",
    mcp: {
      command: "codex mcp remove codex-lcm",
    },
    hook_command_match: "codex-lcm",
  };
}

export function readStatus(options: InstallerOptions = {}) {
  const home = path.resolve(options.codexHome ?? codexHome());
  const root = path.resolve(options.root ?? pluginRoot());
  const configPath = path.join(home, "config.toml");
  const hooksPath = path.join(home, "hooks.json");
  const configText = readOptional(configPath);
  const hooksText = readOptional(hooksPath);
  const pluginManifestText = readOptional(path.join(root, ".codex-plugin", "plugin.json"));
  const pluginManifestAvailable = pluginManifestText !== undefined;
  const mcpManifestAvailable = fs.existsSync(path.join(root, ".mcp.json"));
  const hookManifestAvailable =
    fs.existsSync(path.join(root, "hooks", "hooks.codex.json")) || fs.existsSync(path.join(root, "hooks.json"));
  const pluginDeclaresMcp = pluginManifestText !== undefined && /"mcpServers"\s*:/u.test(pluginManifestText);
  const pluginDeclaresHooks = pluginManifestText !== undefined && /"hooks"\s*:/u.test(pluginManifestText);
  const marketplaceConfigured = configText !== undefined && /\[marketplaces\.codex-lcm\]/u.test(configText);
  const pluginConfigured = configText !== undefined && /\[plugins\."codex-lcm@codex-lcm"\]/u.test(configText);
  const manualMcpConfigured =
    configText !== undefined && /mcp_servers\.(?:"codex-lcm"|codex-lcm)|command\s*=\s*".*codex-lcm/u.test(configText);
  const manualHooksConfigured = hooksText !== undefined && hooksText.includes("codex-lcm");
  const pluginOwnedWiringAvailable = pluginConfigured && pluginManifestAvailable;
  return {
    codex_home: home,
    config_exists: configText !== undefined,
    hooks_json_exists: hooksText !== undefined,
    marketplace_configured: marketplaceConfigured,
    plugin_configured: pluginConfigured,
    plugin_manifest_available: pluginManifestAvailable,
    plugin_declares_mcp: pluginDeclaresMcp,
    plugin_declares_hooks: pluginDeclaresHooks,
    mcp_manifest_available: mcpManifestAvailable,
    hook_manifest_available: hookManifestAvailable,
    manual_mcp_configured: manualMcpConfigured,
    manual_hooks_configured: manualHooksConfigured,
    mcp_configured: manualMcpConfigured || (pluginOwnedWiringAvailable && pluginDeclaresMcp && mcpManifestAvailable),
    hooks_configured: manualHooksConfigured || (pluginOwnedWiringAvailable && pluginDeclaresHooks && hookManifestAvailable),
    recall_skill_available: fs.existsSync(path.join(root, "skills", "lcm-recall", "SKILL.md")),
  };
}

function buildHookConfig(root: string) {
  const binPath = path.join(root, "bin", "codex-lcm");
  const hooks: Record<string, Array<{ hooks: Array<{ type: "command"; command: string; statusMessage?: string }>; matcher?: string }>> = {};
  for (const event of HOOK_EVENTS) {
    const entry: { hooks: Array<{ type: "command"; command: string; statusMessage?: string }>; matcher?: string } = {
      hooks: [
        {
          type: "command",
          command: `node ${JSON.stringify(binPath)} hook ${event}`,
        },
      ],
    };
    if (event === "PreToolUse") entry.matcher = ".*";
    hooks[event] = [entry];
  }
  return { hooks };
}

function readOptional(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}
