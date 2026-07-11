import path from "node:path";

import type { MemoryKind, MemoryPayload, MemoryScope, MemoryStatus, NormalizedEvent } from "./events.ts";
import { resolveGitMetadata } from "./git.ts";

export type DurableMemory = {
  readonly memory_id: string; readonly revision_event_id: string; readonly session_id: string; readonly updated_at: string;
  readonly revision: number; readonly kind: MemoryKind; readonly scope: MemoryScope; readonly status: MemoryStatus;
  readonly text: string; readonly tags: string[]; readonly provenance: MemoryPayload["provenance"]; readonly source_event_ids: string[];
};
export type MemoryRevision = DurableMemory & { readonly operation: MemoryPayload["operation"]; readonly reason?: string };
export type MemorySourceReference = { readonly revision_event_id: string; readonly source_event_id: string; readonly event_ids: string[] };
export type MemorySourceContext = { readonly events: NormalizedEvent[]; readonly sources: MemorySourceReference[] };
export type MemoryDetail = { readonly memory: DurableMemory; readonly revisions: MemoryRevision[]; readonly source_context: MemorySourceContext; readonly next_history_cursor?: string };
export type MemorySearchArgs = { readonly query?: string; readonly limit?: number; readonly cwd?: string; readonly repoRoot?: string; readonly scopeKinds?: MemoryScope["kind"][]; readonly statuses?: MemoryStatus[]; readonly kinds?: MemoryKind[]; readonly tags?: string[] };
export type MemoryReadArgs = { readonly cwd?: string; readonly repoRoot?: string; readonly includeContext?: boolean; readonly before?: number; readonly after?: number; readonly historyLimit?: number; readonly historyCursor?: string };
export type MemorySourceEventIds = readonly [string, ...string[]];
export type CreateMemoryArgs = { readonly sessionId: string; readonly cwd: string; readonly text: string; readonly kind: MemoryKind; readonly tags?: string[]; readonly scope?: MemoryScope; readonly sourceEventIds: MemorySourceEventIds; readonly rationale: string; readonly memoryId?: string };
export type ReviseMemoryArgs = { readonly memoryId: string; readonly expectedRevision: number; readonly sessionId: string; readonly cwd: string; readonly text: string; readonly reason: string; readonly tags?: string[]; readonly kind?: MemoryKind; readonly scope?: MemoryScope; readonly sourceEventIds?: readonly string[] };
export type MemoryTransitionArgs = { readonly memoryId: string; readonly expectedRevision: number; readonly sessionId: string; readonly cwd: string; readonly reason: string };

export function memoryTransitionCategory(payload: MemoryPayload, current: DurableMemory | undefined): string | undefined {
  if (!current) return payload.operation === "create" && payload.revision === 1 ? undefined : "gap";
  if (payload.operation === "create" || payload.revision <= current.revision) return "duplicate_revision";
  if (payload.revision !== current.revision + 1) return "gap";
  if (payload.expected_revision !== current.revision) return "stale_expected_revision";
  if (current.status === "deleted" || (current.status === "deprecated" && payload.operation !== "delete")) return "illegal_transition";
  return undefined;
}

export function memoryInheritsCurrentState(payload: MemoryPayload, current: DurableMemory): boolean {
  return payload.operation === "create" || payload.operation === "revise" || (payload.kind === current.kind && memoryScopesEqual(payload.scope, current.scope) && arraysEqual(payload.tags, current.tags) && arraysEqual(payload.source_event_ids, current.source_event_ids));
}

export function memoryScopeMatchesEvent(event: NormalizedEvent, scope: MemoryScope, sources: readonly NormalizedEvent[]): boolean {
  if (scope.kind === "global") return true;
  if (scope.kind === "cwd") return scope.key === path.resolve(event.cwd) && sources.every((source) => scope.key === path.resolve(source.cwd));
  return scope.key === event.repo_root && sources.every((source) => source.repo_root === undefined || source.repo_root === scope.key);
}

export function resolveMemoryScope(cwd: string, scope: MemoryScope): MemoryScope {
  const canonicalCwd = path.resolve(cwd);
  if (scope.kind === "global") return scope;
  if (scope.kind === "cwd") return { kind: "cwd", key: canonicalCwd };
  const repoRoot = resolveGitMetadata(canonicalCwd).repoRoot;
  if (!repoRoot) throw new Error("Memory repo scope requires a resolvable repo root.");
  if (scope.key !== repoRoot) throw new Error("Memory repo scope must equal the operation cwd repository root.");
  return { kind: "repo", key: repoRoot };
}

export function memoryFromPayload(event: NormalizedEvent, payload: MemoryPayload, current: DurableMemory | undefined): DurableMemory {
  return { memory_id: payload.memory_id, revision_event_id: event.event_id, session_id: event.session_id, updated_at: event.timestamp, revision: payload.revision, kind: payload.kind, scope: payload.scope, status: payload.status, text: payload.text ?? current?.text ?? "", tags: [...payload.tags], provenance: payload.provenance, source_event_ids: [...payload.source_event_ids] };
}

export function rowToDurableMemory(row: unknown): DurableMemory {
  const record = recordValue(row); const scopeKind = String(record.scope_kind);
  if (scopeKind !== "global" && scopeKind !== "repo" && scopeKind !== "cwd") throw new Error(`Invalid memory scope kind in index: ${scopeKind}`);
  const scope: MemoryScope = scopeKind === "global" ? { kind: "global" } : { kind: scopeKind, key: String(record.scope_key) };
  return { memory_id: String(record.memory_id), revision_event_id: String(record.revision_event_id), session_id: String(record.session_id), updated_at: String(record.updated_at), revision: Number(record.revision), kind: memoryKindFromIndex(record.kind), scope, status: memoryStatusFromIndex(record.status), text: String(record.text), tags: jsonStringArray(record.tags_json), provenance: jsonProvenance(record.provenance_json), source_event_ids: jsonStringArray(record.source_event_ids_json) };
}

export function memoryPayloadStatusMismatch(value: unknown): boolean {
  if (!isRecord(value) || typeof value.operation !== "string" || typeof value.status !== "string") return false;
  const status = value.operation === "create" || value.operation === "revise" ? "active" : value.operation === "deprecate" ? "deprecated" : value.operation === "delete" ? "deleted" : undefined;
  return status !== undefined && value.status !== status;
}
export function memoryScopesEqual(left: MemoryScope, right: MemoryScope): boolean { return left.kind === right.kind && (left.kind === "global" || (right.kind !== "global" && left.key === right.key)); }
export function memorySourcesInSession(sessionId: string, sourceEventIds: readonly string[], sourceEvent: (eventId: string) => NormalizedEvent | undefined): NormalizedEvent[] | undefined {
  const sources: NormalizedEvent[] = [];
  for (const sourceEventId of sourceEventIds) {
    const source = sourceEvent(sourceEventId);
    if (source?.session_id !== sessionId) return undefined;
    sources.push(source);
  }
  return sources;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function memoryKindFromIndex(value: unknown): MemoryKind {
  if (value === "preference" || value === "decision" || value === "lesson" || value === "fact" || value === "workflow") return value;
  throw new Error(`Invalid memory kind in index: ${String(value)}`);
}

function memoryStatusFromIndex(value: unknown): MemoryStatus {
  if (value === "active" || value === "deprecated" || value === "deleted") return value;
  throw new Error(`Invalid memory status in index: ${String(value)}`);
}

function jsonStringArray(value: unknown): string[] {
  const parsed: unknown = JSON.parse(String(value));
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error("Invalid string array in memory index.");
  }
  return parsed;
}

function jsonProvenance(value: unknown): MemoryPayload["provenance"] {
  const parsed: unknown = JSON.parse(String(value));
  if (!isRecord(parsed) || parsed.actor !== "agent" || typeof parsed.rationale !== "string") {
    throw new Error("Invalid provenance in memory index.");
  }
  return { actor: parsed.actor, rationale: parsed.rationale };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Invalid memory index row.");
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
