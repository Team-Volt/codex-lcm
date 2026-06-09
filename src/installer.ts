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
  const configPath = path.join(home, "config.toml");
  const hooksPath = path.join(home, "hooks.json");
  const configText = readOptional(configPath);
  const hooksText = readOptional(hooksPath);
  return {
    codex_home: home,
    config_exists: configText !== undefined,
    hooks_json_exists: hooksText !== undefined,
    mcp_configured: configText !== undefined && /mcp_servers\.(?:"codex-lcm"|codex-lcm)|command\s*=\s*".*codex-lcm/u.test(configText),
    hooks_configured: hooksText !== undefined && hooksText.includes("codex-lcm"),
  };
}

export function buildHookConfig(root: string) {
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
