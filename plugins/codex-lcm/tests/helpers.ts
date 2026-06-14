import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import os from "node:os";
import path from "node:path";

export function tempHome(prefix = "codex-lcm-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function readJsonl(filePath: string): unknown[] {
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (raw.length === 0) return [];
  return raw.split(/\r?\n/u).map((line) => JSON.parse(line));
}

export function runCli(args: string[], options: {
  input?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeout?: number;
} = {}) {
  return spawnSync(process.execPath, ["--no-warnings", "bin/codex-lcm", ...args], {
    cwd: path.resolve("."),
    encoding: "utf8",
    input: options.input,
    env: {
      ...process.env,
      ...options.env,
    },
    timeout: options.timeout ?? 5_000,
  });
}

export function assertCliOk(result: ReturnType<typeof runCli>): void {
  assert.equal(result.status, 0, result.stderr);
}

export function runMcp(requests: unknown[], env: NodeJS.ProcessEnv = {}) {
  const result = runCli(["mcp"], {
    input: `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`,
    env,
    timeout: 5_000,
  });
  assertCliOk(result);
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

export function clearDerivedSummaries(home: string): void {
  const db = new DatabaseSync(path.join(home, "index.sqlite"));
  try {
    db.exec(`
      DELETE FROM summary_node_fts;
      DELETE FROM summary_nodes;
      DELETE FROM session_summary_fts;
      DELETE FROM session_summaries;
    `);
  } finally {
    db.close();
  }
}
