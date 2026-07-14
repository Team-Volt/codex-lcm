import path from "node:path";

import {
  contentSourceText,
  contentText,
  isCrossShapeMessageDuplicate,
  isSyntheticContextText,
  type MessageFingerprintState,
} from "./codex-message.ts";
import { normalizeHookEvent, type NormalizedEvent } from "./events.ts";

export type ImportState = MessageFingerprintState & {
  cwd?: string;
  repoRoot?: string;
  gitBranch?: string;
  model?: string;
  reasoningEffort?: string;
};

export function codexRecordToEvent(
  record: Record<string, unknown>,
  file: string,
  state: ImportState,
): NormalizedEvent | undefined {
  const payload = isRecord(record.payload) ? record.payload : {};
  const type = stringValue(record.type);
  const timestamp = stringValue(record.timestamp) || stringValue(payload.timestamp) || new Date(0).toISOString();
  if (Number.isNaN(new Date(timestamp).getTime())) throw new Error(`invalid timestamp: ${timestamp}`);

  if (type === "session_meta") {
    const sessionId = stringValue(payload.id);
    if (sessionId && state.sessionId && sessionId !== state.sessionId) {
      state.cwd = undefined;
      state.repoRoot = undefined;
      state.gitBranch = undefined;
      state.turnId = undefined;
      state.unmatchedMessageFingerprints = undefined;
    }
    state.sessionId = sessionId || state.sessionId || sessionIdFromFile(file);
    state.cwd = stringValue(payload.cwd) || state.cwd || "";
    return normalizeImportEvent({
      hookEvent: "SessionStart",
      timestamp,
      sessionId: state.sessionId,
      cwd: state.cwd || "",
      payload: {
        session_id: state.sessionId,
        cwd: state.cwd || "",
        imported_from: file,
        codex_record_type: type,
        source_timestamp: timestamp,
        metadata: payload,
      },
      state,
    });
  }

  if (type === "turn_context") {
    state.turnId = stringValue(payload.turn_id) || state.turnId;
    state.cwd = stringValue(payload.cwd) || state.cwd;
    state.repoRoot = stringValue(payload.repo_root) || stringValue(payload.repoRoot) || state.repoRoot;
    state.gitBranch = stringValue(payload.git_branch) || stringValue(payload.gitBranch) || state.gitBranch;
    state.model = stringValue(payload.model) || state.model;
    state.reasoningEffort = stringValue(payload.effort) || stringValue(payload.reasoning_effort) || state.reasoningEffort;
    if (!state.model && !state.reasoningEffort) return undefined;
    return normalizeImportEvent({
      hookEvent: "TurnContext",
      timestamp,
      sessionId: state.sessionId || sessionIdFromFile(file),
      cwd: state.cwd || "",
      payload: basePayload(file, type, timestamp, state, {
        ...(state.model ? { model: state.model } : {}),
        ...(state.reasoningEffort ? { reasoning_effort: state.reasoningEffort } : {}),
      }),
      state,
    });
  }

  if (type === "compacted") {
    const summary = stringValue(payload.message);
    if (!summary) return undefined;
    return normalizeImportEvent({
      hookEvent: "PostCompact",
      timestamp,
      sessionId: state.sessionId || sessionIdFromFile(file),
      cwd: state.cwd || "",
      payload: basePayload(file, type, timestamp, state, {
        summary,
        ...(payload.window_id !== undefined ? { window_id: payload.window_id } : {}),
        ...(payload.window_number !== undefined ? { window_number: payload.window_number } : {}),
      }),
      state,
    });
  }

  if (type === "event_msg") {
    const eventType = stringValue(payload.type);
    if (eventType === "token_count" && isRecord(payload.info)) {
      const usage = isRecord(payload.info.total_token_usage) ? payload.info.total_token_usage : undefined;
      if (!usage) return undefined;
      return normalizeImportEvent({
        hookEvent: "TokenCount",
        timestamp,
        sessionId: state.sessionId || sessionIdFromFile(file),
        cwd: state.cwd || "",
        payload: basePayload(file, type, timestamp, state, {
          usage: {
            input_token_count: usage.input_tokens,
            cached_input_token_count: usage.cached_input_tokens,
            output_token_count: usage.output_tokens,
            reasoning_output_token_count: usage.reasoning_output_tokens,
            total_token_count: usage.total_tokens,
          },
          ...(typeof payload.info.model_context_window === "number"
            ? { model_context_window: payload.info.model_context_window }
            : {}),
        }),
        state,
      });
    }
    const role = eventType === "user_message"
      ? "user"
      : eventType === "agent_message"
      ? "assistant"
      : undefined;
    const sourceText = typeof payload.message === "string" ? payload.message : "";
    const text = stringValue(sourceText) || "";
    if (!role || text.length === 0 || isSyntheticContextText(text)) return undefined;
    if (isCrossShapeMessageDuplicate(state, "event_msg", role, sourceText)) return undefined;
    return normalizeImportEvent({
      hookEvent: role === "user" ? "UserPromptSubmit" : "Stop",
      timestamp,
      sessionId: state.sessionId || sessionIdFromFile(file),
      cwd: state.cwd || "",
      payload: basePayload(
        file,
        type,
        timestamp,
        state,
        role === "user" ? { prompt: text } : { last_assistant_message: text },
      ),
      state,
    });
  }

  if (type !== "response_item") return undefined;

  const item = payload;
  const itemType = stringValue(item.type);
  if (itemType === "message") {
    const sourceText = contentSourceText(item.content);
    const role = stringValue(item.role);
    const text = contentText(item.content);
    if (text.length === 0 || isSyntheticContextText(text)) return undefined;
    if (role === "user") {
      if (isCrossShapeMessageDuplicate(state, "response_item", "user", sourceText)) return undefined;
      return normalizeImportEvent({
        hookEvent: "UserPromptSubmit",
        timestamp,
        sessionId: state.sessionId || sessionIdFromFile(file),
        cwd: state.cwd || "",
        payload: basePayload(file, type, timestamp, state, { prompt: text }),
        state,
      });
    }
    if (role === "assistant") {
      if (isCrossShapeMessageDuplicate(state, "response_item", "assistant", sourceText)) return undefined;
      return normalizeImportEvent({
        hookEvent: "Stop",
        timestamp,
        sessionId: state.sessionId || sessionIdFromFile(file),
        cwd: state.cwd || "",
        payload: basePayload(file, type, timestamp, state, { last_assistant_message: text }),
        state,
      });
    }
    return undefined;
  }

  if (itemType === "agent_message") {
    const sourceText = contentSourceText(item.content);
    const text = contentText(item.content);
    if (text.length === 0 || isSyntheticContextText(text)) return undefined;
    if (isCrossShapeMessageDuplicate(state, "response_item", "assistant", sourceText)) return undefined;
    return normalizeImportEvent({
      hookEvent: "Stop",
      timestamp,
      sessionId: state.sessionId || sessionIdFromFile(file),
      cwd: state.cwd || "",
      payload: basePayload(file, type, timestamp, state, {
        last_assistant_message: text,
        ...(stringValue(item.author) ? { author: stringValue(item.author) } : {}),
        ...(stringValue(item.recipient) ? { recipient: stringValue(item.recipient) } : {}),
      }),
      state,
    });
  }

  if (
    itemType === "function_call" ||
    itemType === "tool_search_call" ||
    itemType === "custom_tool_call" ||
    itemType === "web_search_call"
  ) {
    const toolName = stringValue(item.name) || (itemType === "web_search_call" ? "web_search" : itemType);
    const toolUseId = stringValue(item.call_id) || stringValue(item.id);
    return normalizeImportEvent({
      hookEvent: "PreToolUse",
      timestamp,
      sessionId: state.sessionId || sessionIdFromFile(file),
      cwd: state.cwd || "",
      payload: basePayload(file, type, timestamp, state, {
        tool_name: toolName,
        tool_use_id: toolUseId,
        tool_input: parseMaybeJson(item.arguments ?? item.input ?? item.action),
        ...(stringValue(item.status) ? { tool_status: stringValue(item.status) } : {}),
      }),
      state,
    });
  }

  if (
    itemType === "function_call_output" ||
    itemType === "tool_search_output" ||
    itemType === "custom_tool_call_output"
  ) {
    return normalizeImportEvent({
      hookEvent: "PostToolUse",
      timestamp,
      sessionId: state.sessionId || sessionIdFromFile(file),
      cwd: state.cwd || "",
      payload: basePayload(file, type, timestamp, state, {
        tool_use_id: stringValue(item.call_id) || stringValue(item.id),
        tool_response: item.output ?? item.tools ?? item,
      }),
      state,
    });
  }

  return undefined;
}

function normalizeImportEvent(args: {
  hookEvent: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  payload: Record<string, unknown>;
  state: ImportState;
}): NormalizedEvent {
  return normalizeHookEvent({
    hookEvent: args.hookEvent,
    rawInput: JSON.stringify({
      ...args.payload,
      session_id: args.sessionId,
      cwd: args.cwd,
      ...(args.state.turnId ? { turn_id: args.state.turnId } : {}),
    }),
    now: () => new Date(args.timestamp),
    repo: {
      repoRoot: args.state.repoRoot,
      gitBranch: args.state.gitBranch,
    },
  });
}

function basePayload(
  file: string,
  type: string,
  timestamp: string,
  state: ImportState,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...fields,
    imported_from: file,
    codex_record_type: type,
    source_timestamp: timestamp,
    ...(state.turnId ? { turn_id: state.turnId } : {}),
  };
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function rolloutSessionIdFromFile(file: string): string | undefined {
  const base = path.basename(file, ".jsonl");
  return base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu)?.[1];
}

function sessionIdFromFile(file: string): string {
  return rolloutSessionIdFromFile(file) || path.basename(file, ".jsonl");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
