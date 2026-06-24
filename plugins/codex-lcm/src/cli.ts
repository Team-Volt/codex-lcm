import fs from "node:fs";
import path from "node:path";

import { DEFAULT_LIMITS, loadConfig, pluginRoot } from "./config.ts";
import { runLongContextBenchmark } from "./benchmark.ts";
import { importCodexSessions } from "./codex-import.ts";
import { buildDoctorReport } from "./doctor.ts";
import { normalizeHookEvent } from "./events.ts";
import { resolveGitMetadata } from "./git.ts";
import { readStatus } from "./installer.ts";
import { startMcpServer } from "./mcp.ts";
import { sha256 } from "./redact.ts";
import { createStorage } from "./storage.ts";

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    process.stdout.write("0.2.1\n");
    return;
  }
  if (command === "--help" || command === "-h" || command === undefined) {
    printHelp();
    return;
  }
  if (command === "mcp") {
    startMcpServer();
    return;
  }
  if (command === "hook") {
    await runHook(rest);
    return;
  }
  if (command === "status") {
    printObjectOrText(readStatus({ codexHome: optionValue(rest, "--codex-home"), root: pluginRoot() }));
    return;
  }
  if (command === "doctor") {
    const storage = createStorage({ config: loadConfig(), readOnly: true });
    try {
      printObjectOrText(buildDoctorReport({
        status: readStatus({ codexHome: optionValue(rest, "--codex-home"), root: pluginRoot() }),
        health: storage.health(),
      }));
    } finally {
      storage.close();
    }
    return;
  }
  if (command === "import-codex-sessions") {
    const dryRun = rest.includes("--dry-run");
    const showProgress = rest.includes("--progress");
    const storage = createStorage({ config: loadConfig(), readOnly: dryRun });
    try {
      printObjectOrText(importCodexSessions(storage, {
        from: optionValue(rest, "--from"),
        dryRun,
        batchSize: numberOptionValue(rest, "--batch-size"),
        progress: showProgress ? (report) => {
          process.stderr.write(`codex-lcm import: files=${report.files_scanned} records=${report.records_read} importable=${report.events_importable} imported=${report.events_imported} duplicates=${report.events_skipped_duplicate} skipped=${report.records_skipped} rate=${report.events_per_second}/s\n`);
        } : undefined,
      }));
    } finally {
      storage.close();
    }
    return;
  }
  if (command === "benchmark") {
    const benchmarkName = rest[0];
    if (benchmarkName !== "long-context") throw new Error("Usage: codex-lcm benchmark long-context [--events N] [--budget-tokens N] [--home PATH] [--json]");
    printObjectOrText(runLongContextBenchmark({
      events: numberOptionValue(rest, "--events"),
      budgetTokens: numberOptionValue(rest, "--budget-tokens"),
      home: optionValue(rest, "--home"),
    }));
    return;
  }
  if (command === "health") {
    const storage = createStorage({ config: loadConfig(), readOnly: true });
    try {
      printObjectOrText(storage.health());
    } finally {
      storage.close();
    }
    return;
  }
  if (command === "stats") {
    const storage = createStorage({ config: loadConfig(), readOnly: true });
    try {
      printObjectOrText(storage.stats());
    } finally {
      storage.close();
    }
    return;
  }
  if (command === "context-plan") {
    const storage = createStorage({ config: loadConfig(), readOnly: true });
    try {
      printObjectOrText(storage.getContextPlan({
        sessionId: optionValue(rest, "--session-id"),
        cwd: optionValue(rest, "--cwd"),
        repoRoot: optionValue(rest, "--repo-root"),
        modelContextWindow: numberOptionValue(rest, "--model-context-window"),
        autoCompactTokenLimit: numberOptionValue(rest, "--auto-compact-token-limit"),
        recentEventLimit: numberOptionValue(rest, "--recent-event-limit"),
      }));
    } finally {
      storage.close();
    }
    return;
  }
  throw new Error(`Unknown command: ${command}`);
}

async function runHook(args: string[]): Promise<void> {
  const hookEvent = args[0];
  if (!hookEvent) throw new Error("Usage: codex-lcm hook <event>");
  const rawInput = await readStdinWithLimit();
  const payloadCwd = extractCwd(rawInput) ?? process.env.PWD ?? process.cwd();
  const config = loadConfig();
  const event = normalizeHookEvent({
    hookEvent,
    rawInput,
    env: process.env,
    repo: resolveGitMetadata(payloadCwd),
  });
  const storage = createStorage({ config });
  let stored = false;
  try {
    storage.ingest(event);
    stored = true;
  } catch (error) {
    process.stderr.write(`codex-lcm: failed to store hook event: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    storage.close();
  }
  if (!stored) return;
  const output = postCompactRecoveryOutput({
    home: config.home,
    hookEvent: event.hook_event,
    sessionId: event.session_id,
    payload: event.payload,
  });
  if (output.length > 0) process.stdout.write(output);
}

function postCompactRecoveryOutput(args: {
  home: string;
  hookEvent: string;
  sessionId: string;
  payload: Record<string, unknown>;
}): string {
  if (args.hookEvent === "PostCompact") {
    markPostCompactPending(args.home, args.sessionId);
    return "";
  }
  if (args.hookEvent !== "SessionStart" || args.payload.source !== "compact") return "";
  if (!claimPostCompactPending(args.home, args.sessionId)) return "";
  return formatAdditionalContextOutput("SessionStart", buildPostCompactLcmDirective());
}

function markPostCompactPending(home: string, sessionId: string): void {
  fs.mkdirSync(postCompactRecoveryDir(home), { recursive: true });
  fs.writeFileSync(postCompactRecoveryPath(home, sessionId), JSON.stringify({ pending: true }));
}

function claimPostCompactPending(home: string, sessionId: string): boolean {
  const markerPath = postCompactRecoveryPath(home, sessionId);
  if (!fs.existsSync(markerPath)) return false;
  fs.unlinkSync(markerPath);
  return true;
}

function postCompactRecoveryPath(home: string, sessionId: string): string {
  return path.join(postCompactRecoveryDir(home), `${sha256(sessionId).slice(0, 24)}.json`);
}

function postCompactRecoveryDir(home: string): string {
  return path.join(home, "post-compact-recovery");
}

function formatAdditionalContextOutput(hookEventName: string, additionalContext: string): string {
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName,
      additionalContext,
    },
  })}\n`;
}

function buildPostCompactLcmDirective(): string {
  return [
    "## MANDATORY: POST-COMPACTION LCM RECOVERY",
    "",
    "Context compaction just ran. Before continuing any task that may depend on earlier turns, call Codex LCM now.",
    "",
    "Use `lcm_pack_context` for broad recovery of the current task/session.",
    "Use `lcm_expand_query` when you need focused source evidence for a specific prior decision, bug, test result, or implementation detail.",
    "",
    "Do not rely on memory alone for pre-compaction details that are retrievable through LCM.",
  ].join("\n");
}

function printHelp(): void {
  process.stdout.write(`codex-lcm

Commands:
  codex-lcm mcp
  codex-lcm hook <event>
  codex-lcm status [--json]
  codex-lcm doctor [--json]              Diagnose install, storage, and capture state
  codex-lcm health [--json]
  codex-lcm stats [--json]
  codex-lcm context-plan [--session-id ID] [--cwd PATH] [--repo-root PATH] [--model-context-window N] [--auto-compact-token-limit N] [--recent-event-limit N] [--json]
  codex-lcm benchmark long-context [--events N] [--budget-tokens N] [--home PATH] [--json]
  codex-lcm import-codex-sessions [--from PATH] [--dry-run] [--progress] [--batch-size N] [--json]
`);
}

async function readStdinWithLimit(limit = DEFAULT_LIMITS.maxInputBytes): Promise<string> {
  const chunks: string[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > limit) {
      throw new Error(`Hook input exceeds the ${limit} byte limit.`);
    }
    chunks.push(text);
  }
  return chunks.join("");
}

function extractCwd(rawInput: string): string | undefined {
  try {
    const payload = JSON.parse(rawInput) as { cwd?: unknown };
    return typeof payload.cwd === "string" && payload.cwd.trim().length > 0 ? payload.cwd.trim() : undefined;
  } catch {
    return undefined;
  }
}

function optionValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function numberOptionValue(args: string[], flag: string): number | undefined {
  const value = optionValue(args, flag);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function printObjectOrText(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
