import fs from "node:fs";
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
  segmentsDir: string;
  manifestPath: string;
  maintenancePath: string;
  indexPath: string;
  overflowDir: string;
  retentionDays?: number;
  configError?: string;
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
  const retention = retentionDays(home, options.env ?? process.env);
  const segmentsDir = path.join(home, "segments");
  return {
    home,
    rawLogPath: path.join(home, "events.jsonl"),
    segmentsDir,
    manifestPath: path.join(segmentsDir, "manifest.json"),
    maintenancePath: path.join(home, "maintenance.lock.sqlite"),
    indexPath: path.join(home, "index.sqlite"),
    overflowDir: path.join(home, "overflow"),
    retentionDays: retention.value,
    configError: retention.error,
    limits: DEFAULT_LIMITS,
  };
}

function retentionDays(home: string, env: Record<string, string | undefined>): { value?: number; error?: string } {
  const raw = env.CODEX_LCM_RETENTION_DAYS ?? envFileValue(path.join(home, ".env"));
  if (raw === undefined) return {};
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    return { error: "CODEX_LCM_RETENTION_DAYS must be a positive integer." };
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    return { error: "CODEX_LCM_RETENTION_DAYS must be a positive safe integer." };
  }
  return { value };
}

function envFileValue(envPath: string): string | undefined {
  if (!fs.existsSync(envPath)) return undefined;
  let value: string | undefined;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/u)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    if (!line.startsWith("CODEX_LCM_RETENTION_DAYS=")) continue;
    if (value !== undefined) return "";
    value = line.slice("CODEX_LCM_RETENTION_DAYS=".length);
  }
  return value;
}

export function pluginRoot(): string {
  return path.resolve(fileURLToPath(new URL("../", import.meta.url)));
}

export function codexHome(env: Record<string, string | undefined> = process.env): string {
  return path.resolve(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}
