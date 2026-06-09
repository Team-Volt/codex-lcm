import readline from "node:readline";

import { createStorage } from "./storage.ts";

type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

const SERVER_NAME = "codex-lcm";
const SERVER_VERSION = "0.1.0";

const TOOLS = [
  {
    name: "lcm_health",
    title: "LCM Health",
    description: "Report Codex LCM storage and index health.",
    inputSchema: { type: "object", properties: {} },
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
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "lcm_get_session",
    title: "LCM Get Session",
    description: "Retrieve sanitized raw events for a session.",
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
    description: "Pack relevant events and notes into a token-budgeted Markdown context block.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        sessionIds: { type: "array", items: { type: "string" } },
        budgetTokens: { type: "number", default: 1200 },
        cwd: { type: "string" },
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

export function startMcpServer(): void {
  const storage = createStorage();
  const lines = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  lines.on("line", (line) => {
    if (line.trim().length === 0) return;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    handleMessage(message, storage);
  });

  lines.on("close", () => {
    storage.close();
  });
}

function handleMessage(message: JsonRpcMessage, storage: ReturnType<typeof createStorage>): void {
  const { id, method, params } = message;
  if (method === "initialize") {
    sendResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-11-25",
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      instructions: "Use Codex LCM tools to retrieve sanitized session events, notes, and packed context across Codex sessions.",
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
    try {
      sendResult(id, callTool(storage, params ?? {}));
    } catch (error) {
      sendError(id, -32602, error instanceof Error ? error.message : String(error));
    }
    return;
  }
  if (id !== undefined) sendError(id, -32601, `Method not found: ${method ?? ""}`);
}

function callTool(storage: ReturnType<typeof createStorage>, params: Record<string, unknown>) {
  const name = stringArg(params.name, "name");
  const args = isRecord(params.arguments) ? params.arguments : {};
  switch (name) {
    case "lcm_health": {
      const health = storage.health();
      return toolResult(`Codex LCM has ${health.event_count} events across ${health.session_count} sessions.`, { health });
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
      });
      return toolResult(`Found ${matches.length} matching sessions.`, { matches });
    }
    case "lcm_get_session": {
      const session = storage.getSession(stringArg(args.sessionId, "sessionId"));
      return toolResult(`Loaded ${session.events.length} events.`, session);
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
        budgetTokens: optionalNumber(args.budgetTokens),
        cwd: optionalString(args.cwd),
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
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResult(id: JsonRpcMessage["id"], result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: JsonRpcMessage["id"], code: number, message: string): void {
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

function optionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
