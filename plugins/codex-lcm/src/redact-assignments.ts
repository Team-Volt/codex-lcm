import type { RedactionRecord } from "./redact.ts";

const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const SECRET_ASSIGNMENT_RE = /(^|[\s{,;])((?:"[^"\n:=]+"|'[^'\n:=]+'|[A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]\s*)(?:"([^"\n]*)"|'([^'\n]*)'|((?:Bearer|Basic|Digest|Token|OAuth)\s+[^\s,;}]+|[^\s,;{}]+))/giu;
const SECRET_ASSIGNMENT_HINTS = [
  "api",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "credential",
  "password",
  "private",
  "secret",
  "token",
  "database",
] as const;
const BENIGN_TOKEN_METRIC_TERMS = [
  "budget",
  "count",
  "estimated",
  "limit",
  "remaining",
  "total",
  "used",
  "window",
] as const;

export function redactSecretAssignments(value: string, path: string, redactions: RedactionRecord[]): string {
  const redactPrivateKeys = value.replace(PRIVATE_KEY_BLOCK_RE, () => {
    redactions.push({ path, reason: "token-pattern" });
    return "[REDACTED:secret]";
  });

  let output = "";
  let start = 0;
  while (start < redactPrivateKeys.length) {
    const newlineIndex = redactPrivateKeys.indexOf("\n", start);
    const lineEnd = newlineIndex === -1 ? redactPrivateKeys.length : newlineIndex;
    const hasLineBreak = newlineIndex !== -1;
    const lineBreakStart = lineEnd > start && redactPrivateKeys.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    const line = redactPrivateKeys.slice(start, lineBreakStart);

    output += redactSecretAssignmentLine(line, path, redactions);
    if (hasLineBreak) {
      output += redactPrivateKeys.slice(lineBreakStart, lineEnd + 1);
    }
    start = lineEnd + 1;
  }

  return output;
}

export function isBenignTokenMetric(key: string, value: unknown): boolean {
  if (!isTokenMetricKey(key)) return false;
  return typeof value === "number" || typeof value === "boolean";
}

export function shouldRedactSecretKey(key: string, value: unknown): boolean {
  return isSecretAssignmentKey(key) && !isBenignTokenMetric(key, value);
}

function redactSecretAssignmentLine(value: string, path: string, redactions: RedactionRecord[]): string {
  if (!value.includes(":") && !value.includes("=")) return value;

  return value.replace(
    SECRET_ASSIGNMENT_RE,
    (
      match: string,
      prefix: string,
      assignmentPrefix: string,
      doubleQuotedValue: string | undefined,
      singleQuotedValue: string | undefined,
      bareValue: string | undefined,
    ) => redactSecretAssignmentMatch({
      match,
      prefix,
      assignmentPrefix,
      value: doubleQuotedValue ?? singleQuotedValue ?? bareValue ?? "",
      quote: doubleQuotedValue !== undefined ? "\"" : singleQuotedValue !== undefined ? "'" : "",
      path,
      redactions,
    }),
  );
}

function redactSecretAssignmentMatch(args: {
  readonly match: string;
  readonly prefix: string;
  readonly assignmentPrefix: string;
  readonly value: string;
  readonly quote: string;
  readonly path: string;
  readonly redactions: RedactionRecord[];
}): string {
  const key = assignmentKey(args.assignmentPrefix);
  if (!isSecretAssignmentKey(key)) return args.match;
  if (isBenignTokenMetricAssignment(key, args.value)) return args.match;
  if (args.value.startsWith("[REDACTED:secret]")) return args.match;

  if (/^Bearer\s+[^\s"']+/u.test(args.value)) {
    args.redactions.push({ path: args.path, reason: "token-pattern" });
    return `${args.prefix}${args.assignmentPrefix}${args.quote}${args.value.replace(/^Bearer\s+[^\s"']+/u, "Bearer [REDACTED:token]")}${args.quote}`;
  }

  if (args.value.length === 0) return args.match;
  args.redactions.push({ path: args.path, reason: "token-pattern" });
  return `${args.prefix}${args.assignmentPrefix}${args.quote}[REDACTED:secret]${args.quote}`;
}

function assignmentKey(assignmentPrefix: string): string {
  const colonIndex = assignmentPrefix.indexOf(":");
  const equalsIndex = assignmentPrefix.indexOf("=");
  const separatorIndex = colonIndex === -1 ? equalsIndex : equalsIndex === -1 ? colonIndex : Math.min(colonIndex, equalsIndex);
  const key = separatorIndex === -1 ? assignmentPrefix : assignmentPrefix.slice(0, separatorIndex);
  return stripWrappingQuotes(key.trim());
}

function isBenignTokenMetricAssignment(key: string, value: string): boolean {
  if (!isTokenMetricKey(key)) return false;
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?[.!?]?\s*$/u.test(value) ||
    /^(?:true|false|null)[.!?]?\s*$/iu.test(value);
}

function isTokenMetricKey(key: string): boolean {
  const parts = keyParts(key);
  return parts.some((part) => part === "token" || part === "tokens") &&
    parts.some(isBenignTokenMetricTerm);
}

function isBenignTokenMetricTerm(part: string): boolean {
  return BENIGN_TOKEN_METRIC_TERMS.some((term) => term === part);
}

function isSecretAssignmentKey(key: string): boolean {
  const parts = keyParts(key);
  const normalized = parts.join("");
  return parts.some(isSecretAssignmentPart) ||
    normalized.endsWith("token") ||
    normalized.endsWith("tokens") ||
    /^(?:api|private|secret)key$/u.test(normalized) ||
    (parts.some((part) => part === "api") && parts.some((part) => part === "key")) ||
    (parts.some((part) => part === "private") && parts.some((part) => part === "key"));
}

function isSecretAssignmentPart(part: string): boolean {
  return part === "tokens" || SECRET_ASSIGNMENT_HINTS.some((hint) => hint === part);
}

function keyParts(key: string): string[] {
  return stripWrappingQuotes(key)
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function stripWrappingQuotes(value: string): string {
  return value.replace(/^(["'])(.*)\1$/u, "$2");
}
