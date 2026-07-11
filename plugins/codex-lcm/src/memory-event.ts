import { randomUUID } from "node:crypto";
import path from "node:path";

import type { LcmLimits } from "./config.ts";
import type { NormalizedEvent, RepoMetadata } from "./events.ts";
import { resolveGitMetadata } from "./git.ts";

export type MemoryKind = "preference" | "decision" | "lesson" | "fact" | "workflow";
export type MemoryOperation = "create" | "revise" | "deprecate" | "delete";
export type MemoryStatus = "active" | "deprecated" | "deleted";
export type MemoryActor = "agent";
export type MemoryScope = { readonly kind: "global" } | { readonly kind: "repo" | "cwd"; readonly key: string };
export type MemoryProvenance = { readonly actor: MemoryActor; readonly rationale: string };
export type MemoryPayload = {
  readonly operation: MemoryOperation; readonly memory_id: string; readonly revision: number; readonly expected_revision?: number;
  readonly kind: MemoryKind; readonly scope: MemoryScope; readonly status: MemoryStatus; readonly tags: readonly string[];
  readonly source_event_ids: readonly string[]; readonly provenance: MemoryProvenance; readonly text?: string; readonly reason?: string;
};
export type CreateMemoryEventArgs = {
  readonly sessionId: string; readonly cwd: string; readonly text?: unknown; readonly kind: unknown; readonly tags?: unknown;
  readonly scope?: unknown; readonly sourceEventIds?: unknown; readonly rationale?: unknown; readonly reason?: unknown;
  readonly memoryId?: unknown; readonly revision?: unknown; readonly expectedRevision?: unknown; readonly operation?: unknown;
  readonly now?: () => Date; readonly repo?: RepoMetadata; readonly limits?: Partial<LcmLimits>;
};

export const MAX_MEMORY_SOURCE_EVENT_IDS = 32;

export function createMemoryEvent(args: CreateMemoryEventArgs, normalize: (args: { hookEvent: string; rawInput: string; now?: () => Date; repo?: RepoMetadata; limits?: Partial<LcmLimits> }) => NormalizedEvent): NormalizedEvent {
  const operation = memoryOperation(args.operation ?? "create");
  const reason = optionalReason(args.reason, "Memory reason");
  const rationale = requiredReason(operation === "create" ? args.rationale : args.rationale ?? args.reason, "Memory provenance rationale");
  if (operation === "create" && reason !== undefined) throw new Error("Memory create must not include a reason.");
  if (operation !== "create" && reason !== rationale) throw new Error("Memory reason and provenance rationale must match.");
  const cwd = requiredString(args.cwd, "Memory cwd");
  const repo = args.repo ?? resolveGitMetadata(cwd);
  const payload: MemoryPayload = {
    operation, memory_id: memoryId(args.memoryId ?? randomUUID()), revision: positiveInteger(args.revision ?? 1, "Memory revision"),
    ...(operation === "create" ? {} : { expected_revision: positiveInteger(args.expectedRevision, "Memory expected revision") }),
    kind: memoryKind(args.kind), scope: memoryScope(args.scope, cwd, repo), status: memoryStatus(operation), tags: normalizeMemoryTags(args.tags),
    source_event_ids: memorySourceEventIds(args.sourceEventIds, operation !== "create"), provenance: { actor: "agent", rationale },
    ...(operation === "create" || operation === "revise" ? { text: requiredString(args.text, "Memory text") } : {}), ...(reason === undefined ? {} : { reason }),
  };
  return normalize({ hookEvent: "Memory", rawInput: JSON.stringify({ session_id: args.sessionId, cwd, ...payload }), now: args.now, repo, limits: args.limits });
}

export function parseMemoryPayload(value: unknown): MemoryPayload | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const operation = memoryOperation(value.operation);
    const reason = optionalReason(value.reason, "Memory reason");
    const provenance = isRecord(value.provenance) ? value.provenance : undefined;
    const rationale = requiredReason(provenance?.rationale, "Memory provenance rationale");
    if (operation === "create" ? reason !== undefined : reason !== rationale) return undefined;
    const status = memoryStatus(operation);
    if (value.status !== status) return undefined;
    return {
      operation, memory_id: memoryId(value.memory_id), revision: positiveInteger(value.revision, "Memory revision"),
      ...(operation === "create" ? {} : { expected_revision: positiveInteger(value.expected_revision, "Memory expected revision") }),
      kind: memoryKind(value.kind), scope: memoryScopeFromPayload(value.scope), status, tags: normalizeMemoryTags(value.tags),
      source_event_ids: memorySourceEventIds(value.source_event_ids, operation !== "create"), provenance: { actor: memoryActor(provenance?.actor), rationale },
      ...(operation === "create" || operation === "revise" ? { text: requiredString(value.text, "Memory text") } : {}), ...(reason === undefined ? {} : { reason }),
    };
  } catch { // no-excuse-ok: catch - untrusted persisted payloads are quarantined so valid memories still replay.
    return undefined;
  }
}

export function normalizeMemoryTags(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Memory tags must be an array.");
  const tags = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") throw new Error("Memory tag must be a string.");
    const tag = item.normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, "-");
    if (tag.length === 0) throw new Error("Memory tag must not be empty after normalization.");
    if ([...tag].length > 64) throw new Error("Memory tag exceeds 64 Unicode code points.");
    tags.add(tag);
  }
  if (tags.size > 32) throw new Error("Memory tags exceed 32 unique values.");
  return [...tags].sort((left, right) => left.localeCompare(right));
}

function memoryOperation(value: unknown): MemoryOperation {
  if (value === "create" || value === "revise" || value === "deprecate" || value === "delete") return value;
  throw new Error(`Invalid memory operation: ${String(value)}`);
}

function memoryKind(value: unknown): MemoryKind {
  if (value === "preference" || value === "decision" || value === "lesson" || value === "fact" || value === "workflow") return value;
  throw new Error(`Invalid memory kind: ${String(value)}`);
}

function memoryActor(value: unknown): MemoryActor {
  if (value === "agent") return value;
  throw new Error(`Invalid memory actor: ${String(value)}`);
}

function memoryStatus(operation: MemoryOperation): MemoryStatus {
  if (operation === "create" || operation === "revise") return "active";
  if (operation === "deprecate") return "deprecated";
  return "deleted";
}

function memoryId(value: unknown): string {
  const id = requiredString(value, "Memory ID");
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(id)) {
    throw new Error(`Invalid memory ID: ${id}`);
  }
  return id;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  throw new Error(`${label} must be a positive integer.`);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalReason(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  const reason = requiredString(value, label);
  if ([...reason].length > 500) throw new Error(`${label} exceeds 500 Unicode code points.`);
  return reason;
}

function requiredReason(value: unknown, label: string): string {
  const reason = optionalReason(value, label);
  if (reason === undefined) throw new Error(`${label} must be a non-empty string.`);
  return reason;
}

function memoryScope(value: unknown, cwd: string, repo: RepoMetadata): MemoryScope {
  if (value === undefined) return repo.repoRoot ? { kind: "repo", key: repo.repoRoot } : { kind: "global" };
  if (!isRecord(value) || typeof value.kind !== "string") throw new Error("Invalid memory scope.");
  if (value.kind === "global") return { kind: "global" };
  if (value.kind === "cwd") return { kind: "cwd", key: path.resolve(requiredString(cwd, "Memory cwd")) };
  if (value.kind === "repo") {
    if (!repo.repoRoot) throw new Error("Memory repo scope requires a resolvable repo root.");
    return { kind: "repo", key: repo.repoRoot };
  }
  throw new Error(`Invalid memory scope kind: ${value.kind}`);
}

function memoryScopeFromPayload(value: unknown): MemoryScope {
  if (!isRecord(value) || typeof value.kind !== "string") throw new Error("Invalid memory scope.");
  if (value.kind === "global") return { kind: "global" };
  if ((value.kind === "repo" || value.kind === "cwd") && typeof value.key === "string") {
    return { kind: value.kind, key: requiredString(value.key, "Memory scope key") };
  }
  throw new Error(`Invalid memory scope kind: ${value.kind}`);
}

function memorySourceEventIds(value: unknown, allowEmpty: boolean): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error("Memory source event IDs must not be empty.");
  }
  if (value.length > MAX_MEMORY_SOURCE_EVENT_IDS) {
    throw new Error(`Memory source event IDs exceed ${MAX_MEMORY_SOURCE_EVENT_IDS} values.`);
  }
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      throw new Error("Memory source event ID must be a non-empty string.");
    }
    ids.add(item.trim());
  }
  return [...ids];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
