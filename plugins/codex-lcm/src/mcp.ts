import { DEFAULT_LIMITS } from "./config.ts";
import { TOOLS } from "./mcp-catalog.ts";
import { callTool } from "./mcp-tools.ts";

type JsonRpcRequest = {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: Record<string, unknown> | readonly unknown[];
};

const SERVER_NAME = "codex-lcm";
const SERVER_VERSION = "0.2.8";
const SUPPORTED_PROTOCOL_VERSION = "2025-11-25";
const HEADER_SEPARATOR = Buffer.from("\r\n\r\n", "utf8");
const MAX_MESSAGE_BYTES = DEFAULT_LIMITS.maxInputBytes;

let responseFraming: "line" | "header" = "line";

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
        "Use Codex LCM for sanitized local evidence from prior Codex sessions.",
        "Preferred standard workflow: lcm_grep -> lcm_describe -> lcm_expand.",
        "Codex may expose lcm_grep as mcp__codex_lcm__lcm_grep; use the equivalent host-qualified names for the other steps.",
        "Use lcm_expand_query for focused recursive evidence and lcm_pack_context for bounded model-ready recovery after compaction, interruption, or handoff.",
        "For multi-session reviews, call lcm_list_sessions once with includeSummaries; for exact long-session detail, use lcm_describe before bounded graph or paged event reads.",
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
