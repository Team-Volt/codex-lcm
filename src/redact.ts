import { createHash } from "node:crypto";

import { DEFAULT_LIMITS, type LcmLimits } from "./config.ts";

export type RedactionRecord = {
  path: string;
  reason: "secret-key" | "token-pattern";
};

export type TruncationRecord = {
  path: string;
  kind: "string" | "payload";
  original_bytes: number;
  sha256: string;
};

export type SanitizeResult = {
  value: unknown;
  redactions: RedactionRecord[];
  truncations: TruncationRecord[];
  originalBytes: number;
  sanitizedBytes: number;
};

export type RedactionOptions = Partial<LcmLimits>;

const SECRET_KEY_RE = /(^|[_-])(api[_-]?key|authorization|auth|bearer|cookie|credential|password|private[_-]?key|secret|token)([_-]|$)/iu;

type TokenPattern = {
  regex: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
};

const TOKEN_PATTERNS: TokenPattern[] = [
  {
    regex: /Authorization:\s*Bearer\s+[A-Za-z0-9._~+/=-]{8,}/giu,
    replacement: "Authorization: Bearer [REDACTED:token]",
  },
  {
    regex: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gu,
    replacement: "Bearer [REDACTED:token]",
  },
  {
    regex: /\b(sk-[A-Za-z0-9]+)[-_][A-Za-z0-9_-]{6,}\b/gu,
    replacement: (_match: string, prefix: string) => `${prefix}_[REDACTED:token]`,
  },
  {
    regex: /\bghp_[A-Za-z0-9_]{20,}\b/gu,
    replacement: "ghp_[REDACTED:token]",
  },
  {
    regex: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/gu,
    replacement: "github_pat_[REDACTED:token]",
  },
  {
    regex: /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/gu,
    replacement: "xox[REDACTED:token]",
  },
  {
    regex: /\bAKIA[0-9A-Z]{16}\b/gu,
    replacement: "AKIA[REDACTED:token]",
  },
];

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function sanitizeForStorage(value: unknown, options: RedactionOptions = {}): SanitizeResult {
  const limits: LcmLimits = { ...DEFAULT_LIMITS, ...options };
  const redactions: RedactionRecord[] = [];
  const truncations: TruncationRecord[] = [];
  const originalBytes = safeJsonByteLength(value);

  const sanitized = sanitizeValue(value, "$", limits, redactions, truncations);
  const payloadBytes = safeJsonByteLength(sanitized);
  if (payloadBytes > limits.maxPayloadBytes) {
    const json = JSON.stringify(sanitized);
    const preview = json.slice(0, limits.maxPayloadBytes);
    truncations.push({
      path: "$",
      kind: "payload",
      original_bytes: payloadBytes,
      sha256: sha256(json),
    });
    const payload = {
      lcm_truncated: true,
      kind: "payload",
      original_bytes: payloadBytes,
      sha256: sha256(json),
      preview,
    };
    return {
      value: payload,
      redactions,
      truncations,
      originalBytes,
      sanitizedBytes: safeJsonByteLength(payload),
    };
  }

  return {
    value: sanitized,
    redactions,
    truncations,
    originalBytes,
    sanitizedBytes: payloadBytes,
  };
}

function sanitizeValue(
  value: unknown,
  path: string,
  limits: LcmLimits,
  redactions: RedactionRecord[],
  truncations: TruncationRecord[],
): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    return truncateString(redactString(value, path, redactions), path, limits, truncations);
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") return `[${typeof value}]`;

  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeValue(item, `${path}[${index}]`, limits, redactions, truncations));
  }

  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = `${path}.${key}`;
      if (SECRET_KEY_RE.test(key)) {
        output[key] = "[REDACTED:secret]";
        redactions.push({ path: childPath, reason: "secret-key" });
        continue;
      }
      output[key] = sanitizeValue(child, childPath, limits, redactions, truncations);
    }
    return output;
  }

  return String(value);
}

function redactString(value: string, path: string, redactions: RedactionRecord[]): string {
  let output = value;
  for (const pattern of TOKEN_PATTERNS) {
    output = output.replace(pattern.regex, (...args: string[]) => {
      redactions.push({ path, reason: "token-pattern" });
      if (typeof pattern.replacement === "function") {
        return pattern.replacement(args[0], ...args.slice(1));
      }
      return pattern.replacement;
    });
  }
  return output;
}

function truncateString(
  value: string,
  path: string,
  limits: LcmLimits,
  truncations: TruncationRecord[],
): unknown {
  const bytes = byteLength(value);
  if (bytes <= limits.maxStringBytes) return value;
  truncations.push({
    path,
    kind: "string",
    original_bytes: bytes,
    sha256: sha256(value),
  });
  return {
    lcm_truncated: true,
    kind: "string",
    original_bytes: bytes,
    sha256: sha256(value),
    preview: value.slice(0, limits.maxStringBytes),
  };
}

function safeJsonByteLength(value: unknown): number {
  try {
    return byteLength(JSON.stringify(value) ?? "");
  } catch {
    return byteLength(String(value));
  }
}
