import { DEFAULT_LIMITS, type LcmLimits } from "./config.ts";
import { sanitizeForStorage, sha256 } from "./redact.ts";

export type RepoMetadata = {
  repoRoot?: string;
  gitBranch?: string;
};

export type NormalizedEvent = {
  schema_version: 1;
  event_id: string;
  timestamp: string;
  hook_event: string;
  session_id: string;
  cwd: string;
  project?: string;
  repo_root?: string;
  git_branch?: string;
  tool_name?: string;
  payload: Record<string, unknown>;
  redactions: unknown[];
  truncations: unknown[];
  raw_input_sha256: string;
  original_bytes: number;
  sanitized_bytes: number;
};

export type NormalizeHookEventArgs = {
  hookEvent: string;
  rawInput: string | Buffer;
  env?: Record<string, string | undefined>;
  now?: () => Date;
  repo?: RepoMetadata;
  limits?: Partial<LcmLimits>;
};

export function normalizeHookEvent(args: NormalizeHookEventArgs): NormalizedEvent {
  const rawInput = Buffer.isBuffer(args.rawInput) ? args.rawInput.toString("utf8") : args.rawInput;
  const env = args.env ?? process.env;
  const now = args.now ?? (() => new Date());
  const limits = { ...DEFAULT_LIMITS, ...args.limits };
  const rawHash = sha256(rawInput);
  const timestamp = now().toISOString();
  const parsed = parseJson(rawInput);

  if (!parsed.ok) {
    const cwd = env.PWD || process.cwd();
    const sanitizedPreview = sanitizeForStorage(rawInput.slice(0, limits.maxParseErrorPreviewBytes), limits);
    const payload = {
      parse_error: true,
      raw_preview: sanitizedPreview.value,
    };
    const sessionId = fallbackSessionId(args.hookEvent, cwd, rawHash);
    return finalizeEvent({
      hookEvent: args.hookEvent,
      timestamp,
      sessionId,
      cwd,
      payload,
      redactions: sanitizedPreview.redactions,
      truncations: sanitizedPreview.truncations,
      rawHash,
      originalBytes: Buffer.byteLength(rawInput),
      sanitizedBytes: sanitizedPreview.sanitizedBytes,
      repo: args.repo,
    });
  }

  const payloadObject = isRecord(parsed.value) ? parsed.value : { value: parsed.value };
  const cwd = stringValue(payloadObject.cwd) || env.PWD || process.cwd();
  const sessionId =
    stringValue(payloadObject.session_id) ||
    stringValue(payloadObject.sessionId) ||
    stringValue(payloadObject.conversation_id) ||
    stringValue(payloadObject.conversationId) ||
    env.CODEX_SESSION_ID ||
    env.CLAUDE_SESSION_ID ||
    fallbackSessionId(args.hookEvent, cwd, rawHash);
  const sanitized = sanitizeForStorage(payloadObject, limits);

  return finalizeEvent({
    hookEvent: args.hookEvent,
    timestamp,
    sessionId,
    cwd,
    project: stringValue(payloadObject.project),
    toolName: stringValue(payloadObject.tool_name) || stringValue(payloadObject.toolName),
    payload: sanitized.value,
    redactions: sanitized.redactions,
    truncations: sanitized.truncations,
    rawHash,
    originalBytes: sanitized.originalBytes,
    sanitizedBytes: sanitized.sanitizedBytes,
    repo: args.repo,
  });
}

export function createNoteEvent(args: {
  sessionId: string;
  cwd: string;
  text: string;
  now?: () => Date;
  repo?: RepoMetadata;
}): NormalizedEvent {
  const raw = JSON.stringify({
    session_id: args.sessionId,
    cwd: args.cwd,
    note: args.text,
  });
  return normalizeHookEvent({
    hookEvent: "Note",
    rawInput: raw,
    now: args.now,
    repo: args.repo,
  });
}

function finalizeEvent(args: {
  hookEvent: string;
  timestamp: string;
  sessionId: string;
  cwd: string;
  project?: string;
  repo?: RepoMetadata;
  toolName?: string;
  payload: unknown;
  redactions: unknown[];
  truncations: unknown[];
  rawHash: string;
  originalBytes: number;
  sanitizedBytes: number;
}): NormalizedEvent {
  const payload = isRecord(args.payload) ? args.payload : { value: args.payload };
  const eventId = sha256(`${args.hookEvent}\0${args.sessionId}\0${args.timestamp}\0${args.rawHash}`);
  return {
    schema_version: 1,
    event_id: eventId,
    timestamp: args.timestamp,
    hook_event: args.hookEvent,
    session_id: args.sessionId,
    cwd: args.cwd,
    ...(args.project ? { project: args.project } : {}),
    ...(args.repo?.repoRoot ? { repo_root: args.repo.repoRoot } : {}),
    ...(args.repo?.gitBranch ? { git_branch: args.repo.gitBranch } : {}),
    ...(args.toolName ? { tool_name: args.toolName } : {}),
    payload,
    redactions: args.redactions,
    truncations: args.truncations,
    raw_input_sha256: args.rawHash,
    original_bytes: args.originalBytes,
    sanitized_bytes: args.sanitizedBytes,
  };
}

function parseJson(rawInput: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(rawInput) };
  } catch {
    return { ok: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function fallbackSessionId(hookEvent: string, cwd: string, rawHash: string): string {
  return `unknown-${sha256(`${hookEvent}\0${cwd}\0${rawHash}`).slice(0, 12)}`;
}
