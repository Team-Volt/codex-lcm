import { DEFAULT_LIMITS, loadConfig } from "./config.ts";
import { callMemoryTool, isMemoryTool, MEMORY_TOOLS } from "./memory-mcp.ts";
import { createStorage } from "./storage.ts";

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown> | readonly unknown[];
};

const SERVER_NAME = "codex-lcm";
const SERVER_VERSION = "0.2.4";
const SUPPORTED_PROTOCOL_VERSION = "2025-11-25";
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "utf8");
const MAX_MESSAGE_BYTES = DEFAULT_LIMITS.maxInputBytes;
const MEMORY_ENABLED = loadConfig().memoryEnabled;

let responseFraming: "line" | "header" = "line";

const CORE_TOOLS = [
  {
    name: "lcm_health",
    title: "LCM Health",
    description: "Report Codex LCM storage and index health.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_stats",
    title: "LCM Stats",
    description: "Report aggregate LCM index shape, summary depths, graph counts, and freshness without raw transcript text.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_grep",
    title: "LCM Grep",
    description: "Preferred standard workflow step 1 (grep): find relevant sessions by searching summary nodes, session summaries, and high-signal raw events. Codex may surface this tool as mcp__codex_lcm__lcm_grep.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10 },
        cwd: { type: "string" },
        repoRoot: { type: "string" },
        excludeCurrentSession: { type: "boolean", default: false },
        excludeSessionIds: { type: "array", items: { type: "string" } },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_describe",
    title: "LCM Describe",
    description: "Preferred standard workflow step 2 (describe): inspect a session, summary node, or file reference, including summary-node depth and source lineage metadata. Codex may surface this tool as mcp__codex_lcm__lcm_describe.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        nodeId: { type: "string" },
        fileId: { type: "string" },
        limit: { type: "number", default: 50 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_expand",
    title: "LCM Expand",
    description: "Preferred standard workflow step 3 (expand): expand one summary node into bounded source summary nodes and high-signal source events. Codex may surface this tool as mcp__codex_lcm__lcm_expand.",
    inputSchema: {
      type: "object",
      properties: {
        nodeId: { type: "string" },
        query: { type: "string" },
        limit: { type: "number", default: 4 },
      },
      required: ["nodeId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_expand_query",
    title: "LCM Expand Query",
    description: "Find matching summary nodes and recursively expand their source lineage into bounded evidence for a focused query.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        cwd: { type: "string" },
        repoRoot: { type: "string" },
        sessionIds: { type: "array", items: { type: "string" } },
        budgetTokens: { type: "number", default: 2000 },
        limit: { type: "number", default: 4 },
        sourceLimit: { type: "number", default: 6, description: "Maximum source events or source summary nodes considered per matched node." },
        overview: { type: "boolean", default: false, description: "Prefer higher-depth, source-rich summary nodes for broad overview queries." },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_context_plan",
    title: "LCM Context Plan",
    description: "Estimate recent-session token pressure and recommend whether to pack LCM context. This observes pressure only; Codex owns compaction.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cwd: { type: "string" },
        repoRoot: { type: "string" },
        modelContextWindow: { type: "number", default: 128000 },
        autoCompactTokenLimit: { type: "number", default: 96000 },
        recentEventLimit: { type: "number", default: 80 },
        canControlCompaction: {
          type: "boolean",
          const: false,
          default: false,
          description: "Always false; this tool reports context pressure but cannot own Codex compaction.",
        },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_current_session",
    title: "LCM Current Session",
    description: "Find the current or latest known session by session ID, cwd, or repo root.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cwd: { type: "string" },
        repoRoot: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_search_sessions",
    title: "LCM Search Sessions",
    description: "Search across Codex sessions with SQLite FTS.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", default: 10 },
        cwd: { type: "string" },
        repoRoot: { type: "string" },
        excludeCurrentSession: { type: "boolean", default: false },
        excludeSessionIds: { type: "array", items: { type: "string" } },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_get_session",
    title: "LCM Get Session",
    description: "Retrieve sanitized raw events for a session, optionally paged for long sessions.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        limit: { type: "number" },
        cursor: { type: "string" },
      },
      required: ["sessionId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_get_session_summary",
    title: "LCM Get Session Summary",
    description: "Retrieve the deterministic extractive summary for a session, including topics and source event pointers.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_get_session_graph",
    title: "LCM Get Session Graph",
    description: "Retrieve a bounded DAG slice for a session, including session, turn, event, checkpoint, and summary nodes.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        limit: { type: "number", default: 200 },
      },
      required: ["sessionId"],
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_get_recent_context",
    title: "LCM Get Recent Context",
    description: "Retrieve recent events for a session or latest cwd-matching session.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cwd: { type: "string" },
        repoRoot: { type: "string" },
        limit: { type: "number", default: 20 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_pack_context",
    title: "LCM Pack Context",
    description: "Pack relevant summary nodes and bounded source lineage into a token-budgeted Markdown context block.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        sessionIds: { type: "array", items: { type: "string" } },
        budgetTokens: { type: "number", default: 1200 },
        cwd: { type: "string" },
        repoRoot: { type: "string" },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_record_note",
    title: "LCM Record Note",
    description: "Record a user-authored note as a first-class LCM event.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        cwd: { type: "string" },
        text: { type: "string" },
      },
      required: ["sessionId", "cwd", "text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
];

const TOOLS = CORE_TOOLS.flatMap((tool) => MEMORY_ENABLED && tool.name === "lcm_record_note"
  ? [...MEMORY_TOOLS, tool]
  : [tool]);

export function startMcpServer(): void {
  let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  process.stdin.on("data", (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8")]);
    if (buffer.length > MAX_MESSAGE_BYTES) {
      sendError(null, -32700, "Parse error");
      buffer = Buffer.alloc(0);
      return;
    }
    buffer = processInputBuffer(buffer);
  });
}

function processInputBuffer(input: Buffer<ArrayBufferLike>): Buffer<ArrayBufferLike> {
  let buffer = input;
  while (buffer.length > 0) {
    if (startsWithHeader(buffer)) {
      responseFraming = "header";
      const parsed = takeHeaderMessage(buffer);
      if (parsed.kind === "incomplete") return buffer;
      buffer = parsed.remaining;
      handleRawMessage(parsed.body);
      continue;
    }

    const newlineIndex = buffer.indexOf("\n");
    if (newlineIndex === -1) return buffer;
    const line = buffer.subarray(0, newlineIndex).toString("utf8").trim();
    buffer = buffer.subarray(newlineIndex + 1);
    if (line.length === 0) continue;
    handleRawMessage(line);
  }
  return buffer;
}

type ParsedHeaderMessage =
  | { readonly kind: "complete"; readonly body: string; readonly remaining: Buffer }
  | { readonly kind: "incomplete" };

function startsWithHeader(buffer: Buffer): boolean {
  return buffer.subarray(0, "Content-Length:".length).toString("utf8").toLowerCase() === "content-length:";
}

function takeHeaderMessage(buffer: Buffer): ParsedHeaderMessage {
  const headerEnd = buffer.indexOf(HEADER_SEPARATOR);
  if (headerEnd === -1) return { kind: "incomplete" };
  const header = buffer.subarray(0, headerEnd).toString("utf8");
  const lengthMatch = /^Content-Length:\s*(\d+)$/imu.exec(header);
  if (!lengthMatch) {
    sendError(null, -32700, "Parse error");
    return { kind: "complete", body: "", remaining: buffer.subarray(headerEnd + HEADER_SEPARATOR.length) };
  }
  const bodyLength = Number(lengthMatch[1]);
  if (!Number.isSafeInteger(bodyLength) || bodyLength > MAX_MESSAGE_BYTES) {
    sendError(null, -32700, "Parse error");
    return { kind: "complete", body: "", remaining: Buffer.alloc(0) };
  }
  const bodyStart = headerEnd + HEADER_SEPARATOR.length;
  const bodyEnd = bodyStart + bodyLength;
  if (buffer.length < bodyEnd) return { kind: "incomplete" };
  return {
    kind: "complete",
    body: buffer.subarray(bodyStart, bodyEnd).toString("utf8"),
    remaining: buffer.subarray(bodyEnd),
  };
}

function handleRawMessage(raw: string): void {
  if (raw.trim().length === 0) return;
  try {
    const message: unknown = JSON.parse(raw);
    if (!isJsonRpcRequest(message)) {
      sendError(null, -32600, "Invalid Request");
      return;
    }
    handleMessage(message);
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendError(null, -32700, "Parse error");
      return;
    }
    throw error;
  }
}

function handleMessage(message: JsonRpcRequest): void {
  const { id, method, params } = message;
  if (method === "initialize") {
    if (!isInitializeParams(params)) {
      sendError(id, -32602, "Invalid params");
      return;
    }
    sendResult(id, {
      protocolVersion: params.protocolVersion === SUPPORTED_PROTOCOL_VERSION
        ? params.protocolVersion
        : SUPPORTED_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: [
        "Use Codex LCM tools to retrieve sanitized session events, notes, graph checkpoints, summary nodes, and packed context across Codex sessions.",
        "Preferred standard workflow: lcm_grep -> lcm_describe -> lcm_expand.",
        "Codex may surface these same tools as mcp__codex_lcm__lcm_grep, mcp__codex_lcm__lcm_describe, and mcp__codex_lcm__lcm_expand.",
        "Use lcm_expand_query when a focused query should pick matching summary nodes and recursively expand their source evidence.",
        "Use lcm_context_plan to estimate whether recent context is near or past a caller-provided soft limit; it does not control Codex compaction.",
        "Call lcm_pack_context or lcm_search_sessions when resuming work, after compaction, or before answering questions that depend on prior local session context.",
        "Use lcm_pack_context for model-ready summary-node retrieval with bounded source expansion; use lcm_get_session_summary for compact session titles, topics, outcomes, and provenance before loading raw events.",
        "Use lcm_get_session with limit/cursor or lcm_get_session_graph for long sessions instead of loading every event at once.",
      ].join(" "),
    });
    return;
  }
  if (method === "ping") {
    sendResult(id, {});
    return;
  }
  if (method === "tools/list") {
    sendResult(id, { tools: TOOLS });
    return;
  }
  if (method === "tools/call") {
    if (!isToolsCallParams(params)) {
      sendError(id, -32602, "Invalid params");
      return;
    }
    try {
      sendResult(id, callTool(params));
    } catch (error) {
      sendError(id, -32602, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `Method not found: ${method ?? ""}`);
}

function callTool(params: Record<string, unknown>) {
  const name = stringArg(params.name, "name");
  const args = isRecord(params.arguments) ? params.arguments : {};
  if (!MEMORY_ENABLED && isMemoryTool(name)) throw new Error(`Unknown tool: ${name}`);
  const storage = createStorage({ readOnly: !["lcm_record_note", "lcm_create_memory", "lcm_revise_memory", "lcm_deprecate_memory", "lcm_delete_memory"].includes(name) });
  try {
    if (isMemoryTool(name)) return callMemoryTool(storage, name, args);
    switch (name) {
      case "lcm_health": {
        const health = storage.health();
        return toolResult(`Codex LCM has ${health.event_count} events across ${health.session_count} sessions.`, { health });
      }
      case "lcm_stats": {
        const stats = storage.stats();
        return toolResult(
          `Codex LCM has ${stats.event_count} events, ${stats.summary_node_count ?? 0} summary nodes, and ${stats.graph_node_count ?? 0} graph nodes.`,
          { stats },
        );
      }
      case "lcm_grep": {
        const matches = storage.searchSessions({
          query: optionalString(args.query),
          limit: optionalNumber(args.limit),
          cwd: optionalString(args.cwd),
          repoRoot: optionalString(args.repoRoot),
          excludeCurrentSession: optionalBoolean(args.excludeCurrentSession),
          excludeSessionIds: optionalStringArray(args.excludeSessionIds),
        });
        return toolResult(`Found ${matches.length} LCM matches.`, { matches });
      }
      case "lcm_describe": {
        const description = storage.describeMemory({
          sessionId: optionalString(args.sessionId),
          nodeId: optionalString(args.nodeId),
          fileId: optionalString(args.fileId),
          limit: optionalNumber(args.limit),
        });
        const target = description.target === "session"
          ? description.session?.session_id ?? args.sessionId
          : description.target === "summary_node"
            ? description.node.node_id
            : description.file_ref.file_ref_id;
        return toolResult(`Described ${description.target} ${target}.`, { description });
      }
      case "lcm_expand": {
        const expansion = storage.expandMemory({
          nodeId: stringArg(args.nodeId, "nodeId"),
          query: optionalString(args.query),
          limit: optionalNumber(args.limit),
        });
        return toolResult(expansion.markdown, { expansion });
      }
      case "lcm_expand_query": {
        const expansion = storage.expandQuery({
          query: stringArg(args.query, "query"),
          cwd: optionalString(args.cwd),
          repoRoot: optionalString(args.repoRoot),
          sessionIds: optionalStringArray(args.sessionIds),
          budgetTokens: optionalNumber(args.budgetTokens),
          limit: optionalNumber(args.limit),
          sourceLimit: optionalNumber(args.sourceLimit),
          overview: optionalBoolean(args.overview),
        });
        return toolResult(expansion.markdown, { expansion });
      }
      case "lcm_context_plan": {
        const plan = storage.getContextPlan({
          sessionId: optionalString(args.sessionId),
          cwd: optionalString(args.cwd),
          repoRoot: optionalString(args.repoRoot),
          modelContextWindow: optionalNumber(args.modelContextWindow),
          autoCompactTokenLimit: optionalNumber(args.autoCompactTokenLimit),
          recentEventLimit: optionalNumber(args.recentEventLimit),
        });
        return toolResult(`Context plan state: ${plan.state}. ${plan.recommendation}`, { plan });
      }
      case "lcm_current_session": {
        const session = storage.getCurrentSession({
          sessionId: optionalString(args.sessionId),
          cwd: optionalString(args.cwd),
          repoRoot: optionalString(args.repoRoot),
        });
        return toolResult(session ? `Current session: ${session.session_id}` : "No matching session found.", { session });
      }
      case "lcm_search_sessions": {
        const matches = storage.searchSessions({
          query: optionalString(args.query),
          limit: optionalNumber(args.limit),
          cwd: optionalString(args.cwd),
          repoRoot: optionalString(args.repoRoot),
          excludeCurrentSession: optionalBoolean(args.excludeCurrentSession),
          excludeSessionIds: optionalStringArray(args.excludeSessionIds),
        });
        return toolResult(`Found ${matches.length} matching sessions.`, { matches });
      }
      case "lcm_get_session": {
        const session = storage.getSession(stringArg(args.sessionId, "sessionId"), {
          limit: optionalNumber(args.limit),
          cursor: optionalString(args.cursor),
        });
        return toolResult(`Loaded ${session.events.length} events.`, session);
      }
      case "lcm_get_session_summary": {
        const summary = storage.getSessionMemorySummary(stringArg(args.sessionId, "sessionId"));
        return toolResult(summary ? `Loaded summary for ${summary.session_id}.` : "No summary found.", { summary });
      }
      case "lcm_get_session_graph": {
        const graph = storage.getSessionGraph(stringArg(args.sessionId, "sessionId"), {
          limit: optionalNumber(args.limit),
        });
        return toolResult(`Loaded graph with ${graph.nodes.length} nodes and ${graph.edges.length} edges.`, graph);
      }
      case "lcm_get_recent_context": {
        const context = storage.getRecentContext({
          sessionId: optionalString(args.sessionId),
          cwd: optionalString(args.cwd),
          repoRoot: optionalString(args.repoRoot),
          limit: optionalNumber(args.limit),
        });
        return toolResult(`Loaded ${context.events.length} recent events.`, context);
      }
      case "lcm_pack_context": {
        const packed = storage.packContext({
          query: optionalString(args.query),
          sessionIds: optionalStringArray(args.sessionIds),
          currentThreadId: currentThreadId(),
          budgetTokens: optionalNumber(args.budgetTokens),
          cwd: optionalString(args.cwd),
          repoRoot: optionalString(args.repoRoot),
        });
        return toolResult(packed.markdown, packed);
      }
      case "lcm_record_note": {
        const event = storage.recordNote({
          sessionId: stringArg(args.sessionId, "sessionId"),
          cwd: stringArg(args.cwd, "cwd"),
          text: stringArg(args.text, "text"),
        });
        return toolResult(`Recorded note for ${event.session_id}.`, { event });
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } finally {
    storage.close();
  }
}

function send(message: unknown): void {
  const body = JSON.stringify(message);
  if (responseFraming === "header") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
    return;
  }
  process.stdout.write(`${body}\n`);
}

function sendResult(id: JsonRpcRequest["id"], result: unknown): void {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcRequest["id"], code: number, message: string): void {
  if (id === undefined) return;
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function toolResult(text: string, structuredContent: unknown) {
  return {
    content: [{ type: "text", text }],
    structuredContent,
  };
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.trim().length === 0)) {
    throw new Error("value must be an array of non-empty strings.");
  }
  return value.map((item) => item.trim());
}

function currentThreadId(): string | undefined {
  return optionalString(process.env.CODEX_THREAD_ID);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInitializeParams(value: unknown): value is Record<string, unknown> & { readonly protocolVersion: string } {
  if (!isRecord(value) || typeof value.protocolVersion !== "string" || value.protocolVersion.trim().length === 0) {
    return false;
  }
  if ("capabilities" in value && !isRecord(value.capabilities)) return false;
  return !("clientInfo" in value && !isRecord(value.clientInfo));
}

function isToolsCallParams(value: unknown): value is Record<string, unknown> & { readonly name: string } {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.trim().length === 0) return false;
  return !("arguments" in value && !isRecord(value.arguments));
}

function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return false;
  if ("id" in value && value.id !== null && typeof value.id !== "string" && typeof value.id !== "number") {
    return false;
  }
  return !("params" in value && !isRecord(value.params) && !Array.isArray(value.params));
}
