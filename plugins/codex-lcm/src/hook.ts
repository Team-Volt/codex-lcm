import fs from "node:fs";
import path from "node:path";

import { DEFAULT_LIMITS, loadConfig } from "./config.ts";
import { importCodexSessions } from "./codex-import.ts";
import { normalizeHookEvent } from "./events.ts";
import { resolveGitMetadata } from "./git.ts";
import {
  encodeHookStdout,
  type ContextCapableHook,
  type HookStdout,
} from "./host-profile.ts";
import { queueMaintenance } from "./maintenance.ts";
import { sha256 } from "./redact.ts";
import { createStorage } from "./storage.ts";

export async function runHook(args: string[]): Promise<void> {
  const hookEvent = args[0];
  if (!hookEvent) throw new Error("Usage: codex-lcm hook <event>");
  const config = loadConfig();
  const rawInput = await readStdinWithLimit(config.limits.maxOverflowInputBytes);
  const payloadCwd = extractStringField(rawInput, "cwd") ?? process.env.PWD ?? process.cwd();
  const transcriptPath = hookEvent === "SubagentStop"
    ? extractStringField(rawInput, "agent_transcript_path")
    : undefined;
  const toolHook = hookEvent === "PreToolUse" || hookEvent === "PostToolUse";
  const repo = toolHook ? {} : resolveGitMetadata(payloadCwd);
  const event = normalizeHookEvent({
    hookEvent,
    rawInput,
    env: process.env,
    repo,
  });
  if (event.truncations.length > 0 || Buffer.byteLength(rawInput, "utf8") > config.limits.maxInputBytes) {
    const fullEvent = normalizeHookEvent({
      hookEvent,
      rawInput,
      env: process.env,
      repo,
      limits: {
        maxStringBytes: config.limits.maxOverflowInputBytes,
        maxPayloadBytes: config.limits.maxOverflowInputBytes,
      },
    });
    const content = JSON.stringify(fullEvent.payload);
    const hash = sha256(content);
    fs.mkdirSync(config.overflowDir, { recursive: true, mode: 0o700 });
    const overflowPath = path.join(config.overflowDir, `${hash}.json`);
    if (!fs.existsSync(overflowPath)) fs.writeFileSync(overflowPath, content, { mode: 0o600 });
    event.payload.overflow_ref = {
      sha256: hash,
      byte_count: Buffer.byteLength(rawInput, "utf8"),
      sanitized_byte_count: Buffer.byteLength(content, "utf8"),
      path: overflowPath,
    };
  }
  const storage = createStorage({ config });
  try {
    if (toolHook) {
      const session = storage.getCurrentSession({ sessionId: event.session_id });
      event.repo_root = session?.repo_root;
      event.git_branch = session?.git_branch;
    }
    storage.ingest(event);
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
  } finally {
    storage.close();
  }
  queueMaintenance(config);
  const stdout = postCompactRecoveryOutput({
    home: config.home,
    hookEvent: event.hook_event,
    sessionId: event.session_id,
    payload: event.payload,
  });
  const output = encodeHookStdout(event.hook_event, stdout);
  if (output.length > 0) process.stdout.write(output);
}

function postCompactRecoveryOutput(args: {
  home: string;
  hookEvent: string;
  sessionId: string;
  payload: Record<string, unknown>;
}): HookStdout {
  if (args.hookEvent === "PostCompact") {
    markPostCompactPending(args.home, args.sessionId);
    return { kind: "empty" };
  }
  if (args.hookEvent === "PostToolUse" && hasPostCompactPending(args.home, args.sessionId)) {
    const toolName = args.payload.tool_name;
    const isPackTool = toolName === "lcm_pack_context" || toolName === "mcp__codex_lcm__lcm_pack_context";
    if (isPackTool && hasPackedContextResult(args.payload)) {
      claimPostCompactPending(args.home, args.sessionId);
      return { kind: "empty" };
    }
    return additionalContextStdout(args.hookEvent);
  }
  if (args.hookEvent === "Stop" && hasPostCompactPending(args.home, args.sessionId)) {
    return {
      kind: "stopBlock",
      reason: "Post-compaction LCM recovery required: call `lcm_pack_context`, then continue.",
    };
  }
  if (
    args.hookEvent !== "UserPromptSubmit" &&
    (args.hookEvent !== "SessionStart" || (args.payload.source !== "compact" && args.payload.source !== "resume"))
  ) return { kind: "empty" };
  if (!hasPostCompactPending(args.home, args.sessionId)) return { kind: "empty" };
  return additionalContextStdout(args.hookEvent);
}

function additionalContextStdout(hookEvent: string): HookStdout {
  const hookEventName = asContextCapableHook(hookEvent);
  if (!hookEventName) return { kind: "empty" };
  return {
    kind: "additionalContext",
    hookEventName,
    additionalContext: buildPostCompactLcmDirective(),
  };
}

function asContextCapableHook(hookEvent: string): ContextCapableHook | undefined {
  if (hookEvent === "SessionStart" || hookEvent === "UserPromptSubmit" || hookEvent === "PostToolUse") {
    return hookEvent;
  }
  return undefined;
}

function hasPackedContextResult(payload: Record<string, unknown>): boolean {
  if (!Object.hasOwn(payload, "tool_response")) return false;
  const response = payload.tool_response;
  if (!isRecord(response)) return false;
  if (Object.hasOwn(response, "isError") && response.isError !== false) return false;
  const structuredContent = Object.hasOwn(response, "structuredContent")
    ? response.structuredContent
    : undefined;
  return isRecord(structuredContent)
    && Object.hasOwn(structuredContent, "markdown")
    && typeof structuredContent.markdown === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function markPostCompactPending(home: string, sessionId: string): void {
  const recoveryDir = postCompactRecoveryDir(home);
  const markerPath = postCompactRecoveryPath(home, sessionId);
  fs.mkdirSync(recoveryDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(recoveryDir, 0o700);
  fs.writeFileSync(markerPath, JSON.stringify({ pending: true }), { mode: 0o600 });
  fs.chmodSync(markerPath, 0o600);
}

function claimPostCompactPending(home: string, sessionId: string): boolean {
  const markerPath = postCompactRecoveryPath(home, sessionId);
  if (!fs.existsSync(markerPath)) return false;
  fs.unlinkSync(markerPath);
  return true;
}

function hasPostCompactPending(home: string, sessionId: string): boolean {
  return fs.existsSync(postCompactRecoveryPath(home, sessionId));
}

function postCompactRecoveryPath(home: string, sessionId: string): string {
  return path.join(postCompactRecoveryDir(home), `${sha256(sessionId).slice(0, 24)}.json`);
}

function postCompactRecoveryDir(home: string): string {
  return path.join(home, "post-compact-recovery");
}

function buildPostCompactLcmDirective(): string {
  return [
    "## MANDATORY: POST-COMPACTION LCM RECOVERY",
    "",
    "Context compaction just ran. Before continuing any task that may depend on earlier turns, call Codex LCM now.",
    "",
    "Call `lcm_pack_context` once for broad recovery of the current task/session.",
    "Consume `structuredContent.markdown` from that same result; do not call it again to retrieve the Markdown.",
    "Use `lcm_expand_query` when you need focused source evidence for a specific prior decision, bug, test result, or implementation detail.",
    "Perform recovery silently. Unless the user asks, do not announce, describe, summarize, or allude to compaction, recovery, LCM, or checking prior task state; make the next user-visible message only about the task.",
    "After recovery, continue unfinished work unless a concrete blocker remains.",
    "Do not stop or wait for the user merely because compaction occurred.",
    "",
    "Do not rely on memory alone for pre-compaction details that are retrievable through LCM.",
  ].join("\n");
}

async function readStdinWithLimit(limit = DEFAULT_LIMITS.maxOverflowInputBytes): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8");
    bytes += buffer.length;
    if (bytes > limit) {
      throw new Error(`Hook input exceeds the ${limit} byte limit.`);
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
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
