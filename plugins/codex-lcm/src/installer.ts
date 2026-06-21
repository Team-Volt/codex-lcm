import fs from "node:fs";
import path from "node:path";

import { codexHome, pluginRoot } from "./config.ts";

export type InstallerOptions = {
  codexHome?: string;
  root?: string;
};

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

function readOptional(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}
