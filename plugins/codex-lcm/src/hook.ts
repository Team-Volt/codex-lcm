import fs from "node:fs";
import path from "node:path";

import { DEFAULT_LIMITS, loadConfig } from "./config.ts";
import { importCodexSessions } from "./codex-import.ts";
import { normalizeHookEvent } from "./events.ts";
import { resolveGitMetadata } from "./git.ts";
import { sha256 } from "./redact.ts";
import { createStorage } from "./storage.ts";

export async function runHook(args: string[]): Promise<void> {
  const hookEvent = args[0];
  if (!hookEvent) throw new Error("Usage: codex-lcm hook <event>");
  const rawInput = await readStdinWithLimit();
  const payloadCwd = extractStringField(rawInput, "cwd") ?? process.env.PWD ?? process.cwd();
  const transcriptPath = hookEvent === "SubagentStop"
    ? extractStringField(rawInput, "agent_transcript_path")
    : undefined;
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
    if (transcriptPath) {
      try {
        const report = await importCodexSessions(storage, { from: transcriptPath });
        for (const error of report.errors) {
          process.stderr.write(`codex-lcm: failed to import subagent transcript: ${error.message}\n`);
        }
      } catch (error) {
        process.stderr.write(
          `codex-lcm: failed to import subagent transcript: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
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
    return formatAdditionalContextOutput("PostCompact", buildPostCompactLcmDirective());
  }
  if (
    args.hookEvent !== "UserPromptSubmit" &&
    (args.hookEvent !== "SessionStart" || (args.payload.source !== "compact" && args.payload.source !== "resume"))
  ) return "";
  if (!claimPostCompactPending(args.home, args.sessionId)) return "";
  return formatAdditionalContextOutput(args.hookEvent, buildPostCompactLcmDirective());
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
    "After recovery, continue unfinished work unless a concrete blocker remains.",
    "Do not stop or wait for the user merely because compaction occurred.",
    "",
    "Do not rely on memory alone for pre-compaction details that are retrievable through LCM.",
  ].join("\n");
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

function extractStringField(rawInput: string, key: string): string | undefined {
  try {
    const payload = JSON.parse(rawInput) as Record<string, unknown>;
    const value = payload[key];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}
