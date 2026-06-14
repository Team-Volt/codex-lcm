import { DEFAULT_LIMITS, loadConfig, pluginRoot } from "./config.ts";
import { normalizeHookEvent } from "./events.ts";
import { resolveGitMetadata } from "./git.ts";
import { planInstall, planUninstall, readStatus } from "./installer.ts";
import { startMcpServer } from "./mcp.ts";
import { createStorage } from "./storage.ts";

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (command === "--version" || command === "-v") {
    process.stdout.write("0.1.0\n");
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
  if (command === "install") {
    printObjectOrText(planInstall({ codexHome: optionValue(rest, "--codex-home"), root: pluginRoot() }), rest);
    return;
  }
  if (command === "uninstall") {
    printObjectOrText(planUninstall({ codexHome: optionValue(rest, "--codex-home"), root: pluginRoot() }), rest);
    return;
  }
  if (command === "status") {
    printObjectOrText(readStatus({ codexHome: optionValue(rest, "--codex-home"), root: pluginRoot() }), rest);
    return;
  }
  if (command === "health") {
    const storage = createStorage({ config: loadConfig(), readOnly: true });
    try {
      printObjectOrText(storage.health(), rest);
    } finally {
      storage.close();
    }
    return;
  }
  if (command === "stats") {
    const storage = createStorage({ config: loadConfig(), readOnly: true });
    try {
      printObjectOrText(storage.stats(), rest);
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
  const event = normalizeHookEvent({
    hookEvent,
    rawInput,
    env: process.env,
    repo: resolveGitMetadata(payloadCwd),
  });
  const storage = createStorage({ config: loadConfig() });
  try {
    storage.ingest(event);
  } catch (error) {
    process.stderr.write(`codex-lcm: failed to store hook event: ${error instanceof Error ? error.message : String(error)}\n`);
  } finally {
    storage.close();
  }
}

function printHelp(): void {
  process.stdout.write(`codex-lcm

Commands:
  codex-lcm mcp
  codex-lcm hook <event>
  codex-lcm install --dry-run [--json]   Print manual MCP/hook wiring plan
  codex-lcm status [--json]
  codex-lcm health [--json]
  codex-lcm stats [--json]
  codex-lcm uninstall --dry-run [--json] Print manual cleanup plan
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

function printObjectOrText(value: unknown, args: string[]): void {
  if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
