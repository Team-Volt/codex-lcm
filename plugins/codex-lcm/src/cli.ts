import { loadConfig, pluginRoot } from "./config.ts";
import { runLongContextBenchmark } from "./benchmark.ts";
import { importCodexSessions } from "./codex-import.ts";
import { buildDoctorReport } from "./doctor.ts";
import { runHook } from "./hook.ts";
import { readStatus } from "./installer.ts";
import { startMcpServer } from "./mcp.ts";
import { createStorage } from "./storage.ts";

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    process.stdout.write("0.2.5\n");
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
      printObjectOrText(await importCodexSessions(storage, {
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
