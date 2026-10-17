import type { RedactionRecord } from "./redact.ts";

const PRIVATE_KEY_BLOCK_RE = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;
const ASSIGNMENT_PREFIX_RE = /(?<![A-Za-z0-9_.-])(?:"[^"\n:=]+"|'[^'\n:=]+'|[A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]/giu;
const ASSIGNMENT_AT_START_RE = /^(?:"[^"\n:=]+"|'[^'\n:=]+'|[A-Za-z_][A-Za-z0-9_.-]*)\s*[:=]/iu;
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

type QuoteContext = {
  plain: string | undefined;
  escaped: string | undefined;
  offset: number;
};

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

export type KeyRedactionPolicy = "always-secret" | "never-secret" | "value-shape";

export const KEY_POLICY = {
  private: "value-shape",
  token_budget: "value-shape",
  tokens_budget: "value-shape",
  tokens_used: "value-shape",
  token_count: "value-shape",
  auto_compact_token_limit: "value-shape",
  password: "always-secret",
  api_key: "always-secret",
  secret: "always-secret",
  token: "value-shape",
} as const satisfies Record<string, KeyRedactionPolicy>;

export function isBenignTokenMetric(key: string, value: unknown): boolean {
  if (!isTokenMetricKey(key)) return false;
  return typeof value === "number" || typeof value === "boolean";
}

export function keyRedactionPolicy(key: string): KeyRedactionPolicy | undefined {
  const parts = keyParts(key);
  const joined = parts.join("_");
  if (Object.hasOwn(KEY_POLICY, joined)) return KEY_POLICY[joined as keyof typeof KEY_POLICY];
  if (parts.length === 1 && Object.hasOwn(KEY_POLICY, parts[0])) {
    return KEY_POLICY[parts[0] as keyof typeof KEY_POLICY];
  }
  return undefined;
}

export function shouldRedactSecretKey(key: string, value: unknown): boolean {
  const policy = keyRedactionPolicy(key);
  if (policy === "always-secret") return true;
  if (policy === "never-secret") return false;
  if (policy === "value-shape" && keyParts(key).join("_") === "private" && typeof value === "boolean") return false;
  if (isBenignTokenMetric(key, value)) return false;
  return isSecretAssignmentKey(key);
}

function redactSecretAssignmentLine(value: string, path: string, redactions: RedactionRecord[]): string {
  if (!value.includes(":") && !value.includes("=")) return value;

  let output = "";
  let copiedUntil = 0;
  const quoteContext: QuoteContext = { plain: undefined, escaped: undefined, offset: 0 };
  ASSIGNMENT_PREFIX_RE.lastIndex = 0;
  for (let match = ASSIGNMENT_PREFIX_RE.exec(value); match; match = ASSIGNMENT_PREFIX_RE.exec(value)) {
    advanceQuoteContext(value, match.index, quoteContext);
    const key = assignmentKey(match[0]);
    if (!isSecretAssignmentKey(key)) continue;

    const wrapper = quoteContext.escaped
      ? { quote: quoteContext.escaped, escaped: true }
      : quoteContext.plain
        ? { quote: quoteContext.plain, escaped: false }
        : undefined;
    const bounds = assignmentValueBounds(value, ASSIGNMENT_PREFIX_RE.lastIndex, wrapper);
    const assignmentValue = value.slice(bounds.start, bounds.end);
    if (assignmentValue.length === 0 ||
        isBenignTokenMetricAssignment(key, assignmentValue) ||
        assignmentValue.startsWith("[REDACTED:secret]")) {
      continue;
    }

    output += value.slice(copiedUntil, bounds.start);
    output += /^Bearer\s+/u.test(assignmentValue)
      ? assignmentValue.replace(/^Bearer\s+[^\s"']+/u, "Bearer [REDACTED:token]")
      : "[REDACTED:secret]";
    copiedUntil = bounds.end;
    ASSIGNMENT_PREFIX_RE.lastIndex = bounds.end;
    redactions.push({ path, reason: "token-pattern" });
  }
  return output + value.slice(copiedUntil);
}

function assignmentValueBounds(
  value: string,
  start: number,
  wrapper?: { readonly quote: string; readonly escaped: boolean },
): {
  readonly start: number;
  readonly end: number;
} {
  const firstNonWhitespace = value.slice(start).search(/\S/u);
  if (firstNonWhitespace > 0 &&
      !ASSIGNMENT_AT_START_RE.test(value.slice(start + firstNonWhitespace))) {
    start += firstNonWhitespace;
  }
  const openingQuote = value[start];
  if (openingQuote === "\"" || openingQuote === "'") {
    return { start: start + 1, end: closingQuoteIndex(value, start + 1, openingQuote, false) };
  }
  if (openingQuote === "\\" && (value[start + 1] === "\"" || value[start + 1] === "'")) {
    return { start: start + 2, end: closingQuoteIndex(value, start + 2, value[start + 1], true) };
  }

  const end = bareValueEnd(
    value,
    start,
    wrapper?.quote,
    wrapper?.escaped,
  );
  return { start, end };
}

function advanceQuoteContext(value: string, end: number, context: QuoteContext): void {
  for (let index = context.offset; index < end; index += 1) {
    const quote = value[index];
    if (quote !== "\"" && quote !== "'") continue;
    if (hasOddBackslashPrefix(value, index)) {
      context.escaped = context.escaped === quote ? undefined : context.escaped ?? quote;
    } else {
      context.plain = context.plain === quote ? undefined : context.plain ?? quote;
    }
  }
  context.offset = end;
}

function closingQuoteIndex(value: string, start: number, quote: string, escaped: boolean): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] !== quote) continue;
    if (escaped === hasOddBackslashPrefix(value, index)) {
      return escaped ? index - 1 : index;
    }
  }
  return value.length;
}

function bareValueEnd(value: string, start: number, wrapperQuote?: string, escapedWrapper = false): number {
  const scheme = /^(?:Bearer|Basic|Digest|Token|OAuth)\s+/iu.exec(value.slice(start));
  const scanStart = start + (scheme?.[0].length ?? 0);
  for (let index = scanStart; index < value.length; index += 1) {
    if (wrapperQuote && value[index] === wrapperQuote &&
        escapedWrapper === hasOddBackslashPrefix(value, index)) {
      return escapedWrapper ? index - 1 : index;
    }
    if (/[\s,;{}]/u.test(value[index])) return index;
  }
  return value.length;
}

function hasOddBackslashPrefix(value: string, index: number): boolean {
  let count = 0;
  while (index > count && value[index - count - 1] === "\\") count += 1;
  return count % 2 === 1;
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
  return /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?[.!?]?(?:\\?["'])*\s*$/u.test(value) ||
    /^(?:true|false|null)[.!?]?(?:\\?["'])*\s*$/iu.test(value);
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
