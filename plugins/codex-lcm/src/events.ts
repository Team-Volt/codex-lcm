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
      limits,
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
    limits,
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
  limits: LcmLimits;
}): NormalizedEvent {
  const payload = isRecord(args.payload) ? args.payload : { value: args.payload };
  const metadata = sanitizeEventMetadata({
    sessionId: args.sessionId,
    cwd: args.cwd,
    project: args.project,
    repo: args.repo,
    toolName: args.toolName,
    limits: args.limits,
  });
  const eventId = sha256(`${args.hookEvent}\0${args.sessionId}\0${args.timestamp}\0${args.rawHash}`);
  return {
    schema_version: 1,
    event_id: eventId,
    timestamp: args.timestamp,
    hook_event: args.hookEvent,
    session_id: metadata.sessionId,
    cwd: metadata.cwd,
    ...(metadata.project ? { project: metadata.project } : {}),
    ...(metadata.repoRoot ? { repo_root: metadata.repoRoot } : {}),
    ...(metadata.gitBranch ? { git_branch: metadata.gitBranch } : {}),
    ...(metadata.toolName ? { tool_name: metadata.toolName } : {}),
    payload,
    redactions: [...args.redactions, ...metadata.redactions],
    truncations: [...args.truncations, ...metadata.truncations],
    raw_input_sha256: args.rawHash,
    original_bytes: args.originalBytes,
    sanitized_bytes: args.sanitizedBytes + metadata.sanitizedBytes,
  };
}

function sanitizeEventMetadata(args: {
  sessionId: string;
  cwd: string;
  project?: string;
  repo?: RepoMetadata;
  toolName?: string;
  limits: LcmLimits;
}): {
  sessionId: string;
  cwd: string;
  project?: string;
  repoRoot?: string;
  gitBranch?: string;
  toolName?: string;
  redactions: unknown[];
  truncations: unknown[];
  sanitizedBytes: number;
} {
  const sanitized = sanitizeForStorage({
    session_id: args.sessionId,
    cwd: args.cwd,
    ...(args.project ? { project: args.project } : {}),
    ...(args.repo?.repoRoot ? { repo_root: args.repo.repoRoot } : {}),
    ...(args.repo?.gitBranch ? { git_branch: args.repo.gitBranch } : {}),
    ...(args.toolName ? { tool_name: args.toolName } : {}),
  }, args.limits);
  const metadata = isRecord(sanitized.value) ? sanitized.value : {};
  return {
    sessionId: metadataString(metadata.session_id) ?? "[REDACTED:metadata]",
    cwd: metadataString(metadata.cwd) ?? "[REDACTED:metadata]",
    ...(metadataString(metadata.project) ? { project: metadataString(metadata.project) } : {}),
    ...(metadataString(metadata.repo_root) ? { repoRoot: metadataString(metadata.repo_root) } : {}),
    ...(metadataString(metadata.git_branch) ? { gitBranch: metadataString(metadata.git_branch) } : {}),
    ...(metadataString(metadata.tool_name) ? { toolName: metadataString(metadata.tool_name) } : {}),
    redactions: sanitized.redactions,
    truncations: sanitized.truncations,
    sanitizedBytes: sanitized.sanitizedBytes,
  };
}

function metadataString(value: unknown): string | undefined {
  if (typeof value === "string") return stringValue(value);
  if (value === undefined || value === null) return undefined;
  return JSON.stringify(value);
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
