import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LcmLimits = {
  maxInputBytes: number;
  maxOverflowInputBytes: number;
  maxStringBytes: number;
  maxPayloadBytes: number;
  maxParseErrorPreviewBytes: number;
};

export type LcmConfig = {
  home: string;
  rawLogPath: string;
  indexPath: string;
  overflowDir: string;
  limits: LcmLimits;
};

export const DEFAULT_LIMITS: LcmLimits = {
  maxInputBytes: 512 * 1024,
  maxOverflowInputBytes: 8 * 1024 * 1024,
  maxStringBytes: 64 * 1024,
  maxPayloadBytes: 256 * 1024,
  maxParseErrorPreviewBytes: 4 * 1024,
};

function resolveHome(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.CODEX_LCM_HOME || path.join(os.homedir(), ".codex-lcm"));
}

export function loadConfig(options: { home?: string; env?: Record<string, string | undefined> } = {}): LcmConfig {
  const home = path.resolve(options.home || resolveHome(options.env));
  return {
    home,
    rawLogPath: path.join(home, "events.jsonl"),
    indexPath: path.join(home, "index.sqlite"),
    overflowDir: path.join(home, "overflow"),
    limits: DEFAULT_LIMITS,
  };
}

export function pluginRoot(): string {
  return path.resolve(fileURLToPath(new URL("../", import.meta.url)));
}

export function codexHome(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}
