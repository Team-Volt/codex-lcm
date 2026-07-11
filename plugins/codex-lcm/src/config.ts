import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type LcmLimits = {
  maxInputBytes: number;
  maxStringBytes: number;
  maxPayloadBytes: number;
  maxParseErrorPreviewBytes: number;
};

export type LcmConfig = {
  home: string;
  rawLogPath: string;
  indexPath: string;
  memoryEnabled: boolean;
  limits: LcmLimits;
};

export const DEFAULT_LIMITS: LcmLimits = {
  maxInputBytes: 512 * 1024,
  maxStringBytes: 64 * 1024,
  maxPayloadBytes: 256 * 1024,
  maxParseErrorPreviewBytes: 4 * 1024,
};

function resolveHome(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.CODEX_LCM_HOME || path.join(os.homedir(), ".codex-lcm"));
}

export function loadConfig(options: { home?: string; env?: Record<string, string | undefined> } = {}): LcmConfig {
  const env = options.env ?? process.env;
  const home = path.resolve(options.home || resolveHome(env));
  return {
    home,
    rawLogPath: path.join(home, "events.jsonl"),
    indexPath: path.join(home, "index.sqlite"),
    memoryEnabled: enabled(env.CODEX_LCM_MEMORY_ENABLED ?? readDotEnv(home, "CODEX_LCM_MEMORY_ENABLED")),
    limits: DEFAULT_LIMITS,
  };
}

function readDotEnv(home: string, key: string): string | undefined {
  const filePath = path.join(home, ".env");
  if (!fs.existsSync(filePath)) return undefined;
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
  let value: string | undefined;
  for (const line of contents.split(/\r?\n/u)) {
    const assignment = line.trim().replace(/^export\s+/u, "");
    if (assignment.startsWith("#")) continue;
    const separator = assignment.indexOf("=");
    if (separator < 0 || assignment.slice(0, separator).trim() !== key) continue;
    value = assignment.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/u, "$2");
  }
  return value;
}

function enabled(value: string | undefined): boolean {
  return value === "1" || value?.toLocaleLowerCase() === "true";
}

export function pluginRoot(): string {
  return path.resolve(fileURLToPath(new URL("../", import.meta.url)));
}

export function codexHome(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}
