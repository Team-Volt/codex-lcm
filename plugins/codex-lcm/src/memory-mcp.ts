import type { MemoryKind, MemoryScope, MemoryStatus } from "./events.ts";
import { MEMORY_KINDS, MEMORY_SCOPE_KINDS, MEMORY_STATUSES, MEMORY_TOOLS } from "./memory-mcp-schema.ts";
import type { LcmStorage } from "./storage.ts";

export { MEMORY_TOOLS };

type MemoryToolResponse = {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly structuredContent: unknown;
};

export function isMemoryTool(name: string): boolean {
  return MEMORY_TOOLS.some((tool) => tool.name === name);
}

export function callMemoryTool(storage: LcmStorage, name: string, args: Record<string, unknown>): MemoryToolResponse {
  if ("actor" in args) throw new Error("actor is assigned automatically for MCP memory writes.");

  switch (name) {
    case "lcm_create_memory":
      return memoryResult(storage.createMemory({
        sessionId: stringArg(args.sessionId, "sessionId"),
        cwd: stringArg(args.cwd, "cwd"),
        text: stringArg(args.text, "text"),
        kind: memoryKindArg(args.kind),
        tags: stringArray(args.tags),
        scope: memoryScopeArg(args.scope),
        sourceEventIds: sourceEventIds(args.sourceEventIds),
        rationale: stringArg(args.rationale, "rationale"),
        memoryId: optionalMemoryId(args.memoryId),
      }), "Created");
    case "lcm_revise_memory":
      return memoryResult(storage.reviseMemory({
        memoryId: stringArg(args.memoryId, "memoryId"),
        expectedRevision: positiveIntegerArg(args.expectedRevision, "expectedRevision"),
        sessionId: stringArg(args.sessionId, "sessionId"),
        cwd: stringArg(args.cwd, "cwd"),
        text: stringArg(args.text, "text"),
        reason: stringArg(args.reason, "reason"),
        tags: stringArray(args.tags),
        kind: optionalMemoryKind(args.kind),
        scope: memoryScopeArg(args.scope),
        sourceEventIds: optionalSourceEventIds(args.sourceEventIds),
      }), "Revised");
    case "lcm_deprecate_memory":
      return memoryResult(storage.deprecateMemory(transitionArgs(args)), "Deprecated");
    case "lcm_delete_memory":
      return memoryResult(storage.deleteMemory(transitionArgs(args)), "Deleted");
    case "lcm_search_memories": {
      const memories = storage.searchMemories({
        query: optionalString(args.query),
        limit: optionalNumber(args.limit),
        cwd: optionalString(args.cwd),
        repoRoot: optionalString(args.repoRoot),
        tags: stringArray(args.tags),
        kinds: memoryKindsArg(args.kinds),
        statuses: memoryStatusesArg(args.statuses),
        scopeKinds: memoryScopeKindsArg(args.scopeKinds),
      });
      return textResult(`Found ${memories.length} durable memories.`, { memories });
    }
    case "lcm_get_memory": {
      const memory = storage.getMemory(stringArg(args.memoryId, "memoryId"), {
        cwd: stringArg(args.cwd, "cwd"),
        repoRoot: optionalString(args.repoRoot),
        includeContext: optionalBoolean(args.includeContext),
        historyLimit: optionalNumber(args.historyLimit),
        historyCursor: optionalString(args.historyCursor),
      });
      return textResult(`Loaded memory ${memory.memory.memory_id}.`, { memory });
    }
    default:
      throw new Error(`Unknown memory tool: ${name}`);
  }
}

function memoryResult(memory: { readonly memory_id: string; readonly revision: number }, verb: string): MemoryToolResponse {
  const revision = verb === "Created" || verb === "Revised" ? ` at revision ${memory.revision}` : "";
  return textResult(`${verb} memory ${memory.memory_id}${revision}.`, { memory });
}

function textResult(value: string, structuredContent: unknown): MemoryToolResponse {
  return {
    content: [{ type: "text", text: value }],
    structuredContent,
  };
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function positiveIntegerArg(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalMemoryId(value: unknown): string | undefined {
  return value === undefined ? undefined : stringArg(value, "memoryId");
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error("value must be an array of non-empty strings.");
  }
  return value.map((item) => item.trim());
}

function memoryKindArg(value: unknown): MemoryKind {
  const kind = optionalMemoryKind(value);
  if (kind === undefined) throw new Error("kind must be a valid memory kind.");
  return kind;
}

function optionalMemoryKind(value: unknown): MemoryKind | undefined {
  if (value === undefined) return undefined;
  if (isMemoryKind(value)) return value;
  throw new Error("kind must be a valid memory kind.");
}

function memoryKindsArg(value: unknown): MemoryKind[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("kinds must be an array of memory kinds.");
  return value.map(memoryKindArg);
}

function memoryStatusesArg(value: unknown): MemoryStatus[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isMemoryStatus)) {
    throw new Error("statuses must be an array of memory statuses.");
  }
  return value;
}

function memoryScopeKindsArg(value: unknown): MemoryScope["kind"][] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isMemoryScopeKind)) {
    throw new Error("scopeKinds must be an array of memory scope kinds.");
  }
  return value;
}

function memoryScopeArg(value: unknown): MemoryScope | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("scope must be a valid memory scope.");
  if (value.kind === "global" && Object.keys(value).length === 1) return { kind: "global" };
  if ((value.kind === "repo" || value.kind === "cwd") && isScopeKey(value.key) && hasOnlyScopeKeys(value)) {
    return { kind: value.kind, key: value.key.trim() };
  }
  throw new Error("scope must be a valid memory scope.");
}

function sourceEventIds(value: unknown): [string, ...string[]] {
  const values = stringArray(value);
  if (!values || values.length === 0) throw new Error("sourceEventIds must not be empty.");
  if (values.length > 32) throw new Error("sourceEventIds exceed 32 values.");
  const [first, ...rest] = values;
  if (first === undefined) throw new Error("sourceEventIds must not be empty.");
  return [first, ...rest];
}

function optionalSourceEventIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  const values = stringArray(value);
  if (!values) return undefined;
  if (values.length > 32) throw new Error("sourceEventIds exceed 32 values.");
  return values;
}

function transitionArgs(args: Record<string, unknown>) {
  return {
    memoryId: stringArg(args.memoryId, "memoryId"),
    expectedRevision: positiveIntegerArg(args.expectedRevision, "expectedRevision"),
    sessionId: stringArg(args.sessionId, "sessionId"),
    cwd: stringArg(args.cwd, "cwd"),
    reason: stringArg(args.reason, "reason"),
  };
}

function isMemoryKind(value: unknown): value is MemoryKind {
  return MEMORY_KINDS.some((kind) => kind === value);
}

function isMemoryStatus(value: unknown): value is MemoryStatus {
  return MEMORY_STATUSES.some((status) => status === value);
}

function isMemoryScopeKind(value: unknown): value is MemoryScope["kind"] {
  return MEMORY_SCOPE_KINDS.some((kind) => kind === value);
}

function isScopeKey(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyScopeKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => key === "kind" || key === "key");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
