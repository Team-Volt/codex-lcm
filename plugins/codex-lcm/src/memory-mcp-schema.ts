export const MEMORY_KINDS = ["preference", "decision", "lesson", "fact", "workflow"] as const;
export const MEMORY_STATUSES = ["active", "deprecated", "deleted"] as const;
export const MEMORY_SCOPE_KINDS = ["global", "repo", "cwd"] as const;

const memoryScope = {
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "global" } },
      required: ["kind"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "repo" }, key: { type: "string", minLength: 1 } },
      required: ["kind", "key"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "cwd" }, key: { type: "string", minLength: 1 } },
      required: ["kind", "key"],
      additionalProperties: false,
    },
  ],
} as const;

const sourceEventIds = {
  type: "array",
  items: { type: "string" },
  minItems: 1,
  maxItems: 32,
} as const;

const revisableSourceEventIds = {
  ...sourceEventIds,
  minItems: 0,
} as const;

const transitionInput = {
  type: "object",
  properties: {
    memoryId: { type: "string" },
    expectedRevision: { type: "number" },
    sessionId: { type: "string" },
    cwd: { type: "string" },
    reason: { type: "string" },
  },
  required: ["memoryId", "expectedRevision", "sessionId", "cwd", "reason"],
} as const;

export const MEMORY_TOOLS = [
  {
    name: "lcm_create_memory",
    title: "LCM Create Memory",
    description: "Create one append-only durable memory revision from source-backed evidence.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cwd: { type: "string" },
        text: { type: "string" },
        kind: { type: "string", enum: MEMORY_KINDS },
        tags: { type: "array", items: { type: "string" } },
        scope: memoryScope,
        sourceEventIds,
        rationale: { type: "string" },
        memoryId: { type: "string" },
      },
      required: ["sessionId", "cwd", "text", "kind", "sourceEventIds", "rationale"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "lcm_revise_memory",
    title: "LCM Revise Memory",
    description: "Append a replacement active revision for a durable memory.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string" },
        expectedRevision: { type: "number" },
        sessionId: { type: "string" },
        cwd: { type: "string" },
        text: { type: "string" },
        reason: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        kind: { type: "string", enum: MEMORY_KINDS },
        scope: memoryScope,
        sourceEventIds: revisableSourceEventIds,
      },
      required: ["memoryId", "expectedRevision", "sessionId", "cwd", "text", "reason"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "lcm_deprecate_memory",
    title: "LCM Deprecate Memory",
    description: "Append a deprecated tombstone revision for a durable memory.",
    inputSchema: transitionInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "lcm_delete_memory",
    title: "LCM Delete Memory",
    description: "Append a deleted tombstone revision; raw history remains retained.",
    inputSchema: transitionInput,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "lcm_search_memories",
    title: "LCM Search Memories",
    description: "Search applicable latest durable memory state; default status is active.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10 },
        cwd: { type: "string" },
        repoRoot: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        kinds: { type: "array", items: { type: "string", enum: MEMORY_KINDS } },
        statuses: { type: "array", items: { type: "string", enum: MEMORY_STATUSES } },
        scopeKinds: { type: "array", items: { type: "string", enum: MEMORY_SCOPE_KINDS } },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_get_memory",
    title: "LCM Get Memory",
    description: "Get the latest memory state, immutable revision history, and bounded same-session source context.",
    inputSchema: {
      type: "object",
      properties: {
        memoryId: { type: "string" },
        cwd: { type: "string" },
        repoRoot: { type: "string" },
        includeContext: { type: "boolean", default: true },
        historyLimit: { type: "number", minimum: 1, maximum: 100, default: 20 },
        historyCursor: { type: "string" },
      },
      required: ["memoryId", "cwd"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;
