import { createHash } from "node:crypto";

import type { NormalizedEvent } from "./events.ts";

export type SummarySourceType = "events" | "nodes";

export type SummaryNode = {
  node_id: string;
  session_id: string;
  depth: number;
  summary_text: string;
  token_count: number;
  source_token_count: number;
  source_type: SummarySourceType;
  source_ids: string[];
  source_event_ids: string[];
  earliest_at: string;
  latest_at: string;
  created_at: string;
  cwd: string;
  repo_root?: string;
  git_branch?: string;
  topics: string[];
};

export type SessionMemorySummary = {
  session_id: string;
  updated_at: string;
  cwd: string;
  repo_root?: string;
  git_branch?: string;
  title: string;
  overview: string;
  topics: string[];
  key_prompts: string[];
  outcomes: string[];
  tools: string[];
  source_event_ids: string[];
};

export const SUMMARY_ALGORITHM_VERSION = 3;
export const SUMMARY_NODE_VERSION = 2;
export const SUMMARY_NODE_CHUNK_SIZE = 8;
export const SUMMARY_NODE_FANOUT = 4;
export const SUMMARY_NODE_MAX_DEPTH = 8;
export const SUMMARY_NODE_PACK_LIMIT = 6;
export const SUMMARY_NODE_SOURCE_EVENT_LIMIT = 4;

const SUMMARY_SOURCE_EVENT_LIMIT = 12;

// Used only for relaxed matching and topic labels. Strict FTS queries still
// preserve every user token, so exact lookups never depend on this filter.
const COMMON_FUNCTION_TERMS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "if",
  "in",
  "into",
  "is",
  "it",
  "its",
  "just",
  "kind",
  "make",
  "me",
  "my",
  "of",
  "on",
  "or",
  "out",
  "so",
  "than",
  "that",
  "the",
  "then",
  "there",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "will",
  "with",
  "would",
  "you",
]);

export function toFtsQueries(query: string): string[] {
  const strict = toStrictFtsQuery(query);
  const relaxed = toRelaxedFtsQuery(query);
  return relaxed && relaxed !== strict ? [strict, relaxed] : [strict];
}

export function matchesQueryText(text: string, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (trimmed.length === 0) return true;
  const lowered = text.toLowerCase();
  if (lowered.includes(trimmed)) return true;
  return queryTerms(trimmed).some((term) => textContainsTerm(lowered, term));
}

export function queryTermHitCount(text: string, query: string): number {
  return queryTermHitCountFromTerms(text, queryTerms(query));
}

export function rankSummaryNodesForContext(nodes: SummaryNode[], query: string): SummaryNode[] {
  const terms = queryTerms(query);
  if (terms.length === 0) {
    return [...nodes].sort((a, b) =>
      a.depth - b.depth ||
      b.latest_at.localeCompare(a.latest_at));
  }
  const ranks = new Map(nodes.map((node) => [node.node_id, summaryNodeRank(node, terms)]));
  return [...nodes].sort((a, b) => {
    const aRank = ranks.get(a.node_id) ?? summaryNodeRank(a, terms);
    const bRank = ranks.get(b.node_id) ?? summaryNodeRank(b, terms);
    return bRank.focusedHits - aRank.focusedHits ||
      bRank.directness - aRank.directness ||
      bRank.fullHits - aRank.fullHits ||
      a.depth - b.depth ||
      bRank.evidenceSupport - aRank.evidenceSupport ||
      b.latest_at.localeCompare(a.latest_at);
  });
}

export function summaryNodeSearchText(node: SummaryNode): string {
  return [
    node.summary_text,
    ...node.topics,
    ...node.source_event_ids,
  ].join("\n");
}

export function summaryNodeTitle(node: SummaryNode): string {
  const lines = node.summary_text.split(/\r?\n/u);
  const distinctiveSourceLine = lines.find((line) =>
    line.startsWith("- ") && /[A-Z0-9][A-Z0-9_-]{3,}/u.test(line));
  const focusLine = lines.find((line) => line.startsWith("Focus:"));
  return titleFromText(
    distinctiveSourceLine?.replace(/^-\s*/u, "") ??
    focusLine?.replace(/^Focus:\s*/u, "") ??
    node.summary_text,
  );
}

export function summaryNodeToMarkdown(node: SummaryNode): string {
  return [
    `## ${node.latest_at} Summary Node d${node.depth}`,
    `node: ${node.node_id}`,
    `session: ${node.session_id}`,
    `cwd: ${node.cwd}`,
    `window: ${node.earliest_at} .. ${node.latest_at}`,
    `source_type: ${node.source_type}`,
    `source_count: ${node.source_ids.length}`,
    node.topics.length > 0 ? `Topics: ${node.topics.slice(0, 12).join(", ")}` : "",
    node.summary_text,
    "",
  ].filter(Boolean).join("\n");
}

export function summaryNodeToCompactMarkdown(node: SummaryNode, args: {
  sourceEvents: NormalizedEvent[];
}): string {
  const lines = [
    `## Summary Node d${node.depth}`,
    `node: ${node.node_id}`,
    `session: ${node.session_id}`,
  ];
  if (node.topics.length > 0) lines.push(`Topics: ${node.topics.slice(0, 8).join(", ")}`);
  lines.push(node.summary_text);
  if (args.sourceEvents.length > 0) {
    lines.push("### Source Events");
    for (const event of args.sourceEvents) {
      const text = eventSignalText(event);
      if (text.length === 0) continue;
      lines.push(`- ${event.hook_event}: ${truncateText(text, 220)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function summaryNodeExpansionToMarkdown(node: SummaryNode, args: {
  sourceNodes: SummaryNode[];
  sourceEvents: NormalizedEvent[];
}): string {
  const lines: string[] = [];
  if (args.sourceNodes.length > 0) {
    lines.push("### Source Summary Nodes");
    for (const sourceNode of args.sourceNodes) {
      lines.push(`- d${sourceNode.depth} ${sourceNode.node_id}: ${truncateText(sourceNode.summary_text, 180)}`);
    }
    lines.push("");
  }
  if (args.sourceEvents.length > 0) {
    lines.push("### Source Events");
    for (const event of args.sourceEvents) {
      const text = eventSignalText(event);
      if (text.length === 0) continue;
      lines.push(`- ${event.timestamp} ${event.hook_event} ${shortSourceId(event.event_id)}: ${truncateText(text, 220)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function sessionSummaryToMarkdown(summary: SessionMemorySummary): string {
  const displayedPrompts = takeHeadTail(summary.key_prompts, 4, 2);
  const lines = [
    `## ${summary.updated_at} Session Summary`,
    `session: ${summary.session_id}`,
    `cwd: ${summary.cwd}`,
    `Title: ${summary.title}`,
    `Overview: ${truncateText(summary.overview, 180)}`,
  ];
  if (summary.topics.length > 0) lines.push(`Topics: ${summary.topics.slice(0, 16).join(", ")}`);
  if (displayedPrompts.length > 0) lines.push(`Key prompts: ${displayedPrompts.join(" | ")}`);
  if (summary.outcomes.length > 0) lines.push(`Outcomes: ${summary.outcomes.slice(0, 2).join(" | ")}`);
  if (summary.source_event_ids.length > 0) lines.push(`Sources: ${summary.source_event_ids.slice(0, 3).map(shortSourceId).join(", ")}`);
  lines.push("");
  return lines.join("\n");
}

export function summarySearchText(summary: SessionMemorySummary): string {
  return [
    summary.title,
    summary.overview,
    ...summary.topics,
    ...summary.key_prompts,
    ...summary.outcomes,
    ...summary.tools,
  ].join("\n");
}

export function buildLeafSummaryNode(events: NormalizedEvent[]): SummaryNode {
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.event_id.localeCompare(b.event_id));
  const first = sorted[0];
  const latest = sorted.at(-1) ?? first;
  const signals = sorted.map(eventSignalText).filter((text) => text.length > 0);
  const topics = extractTopics(signals);
  const summaryText = [
    `D0 leaf summary covering ${sorted.length} high-signal events.`,
    `Focus: ${titleFromText(signals.at(-1) ?? signals[0] ?? latest.hook_event)}`,
    topics.length > 0 ? `Topics: ${topics.join(", ")}` : "",
    ...takeHeadTail(signals.map((text) => `- ${truncateText(text, 180)}`), 6, 3),
  ].filter(Boolean).join("\n");
  const sourceEventIds = sorted.map((event) => event.event_id);
  return {
    node_id: summaryNodeId(first.session_id, 0, "events", sourceEventIds),
    session_id: first.session_id,
    depth: 0,
    summary_text: summaryText,
    token_count: estimateTokenCount(summaryText),
    source_token_count: sorted.reduce((sum, event) => sum + estimateTokenCount(eventSignalText(event)), 0),
    source_type: "events",
    source_ids: sourceEventIds,
    source_event_ids: sourceEventIds,
    earliest_at: first.timestamp,
    latest_at: latest.timestamp,
    created_at: latest.timestamp,
    cwd: latest.cwd,
    ...(latest.repo_root ? { repo_root: latest.repo_root } : first.repo_root ? { repo_root: first.repo_root } : {}),
    ...(latest.git_branch ? { git_branch: latest.git_branch } : first.git_branch ? { git_branch: first.git_branch } : {}),
    topics,
  };
}

export function buildCondensedSummaryNode(nodes: SummaryNode[], depth: number): SummaryNode {
  const sorted = [...nodes].sort((a, b) => a.earliest_at.localeCompare(b.earliest_at) || a.node_id.localeCompare(b.node_id));
  const first = sorted[0];
  const latest = sorted.at(-1) ?? first;
  const topics = extractTopics(sorted.map((node) => node.topics.join(" ")));
  const sourceIds = sorted.map((node) => node.node_id);
  const sourceEventIds = uniqueStrings(sorted.flatMap((node) => node.source_event_ids));
  const summaryText = [
    `D${depth} condensed summary covering ${sorted.length} D${depth - 1} summary nodes.`,
    `Focus: ${titleFromText(latest.summary_text)}`,
    topics.length > 0 ? `Topics: ${topics.join(", ")}` : "",
    ...takeHeadTail(sorted.map((node) => `- d${node.depth} ${truncateText(node.summary_text, 180)}`), 6, 3),
  ].filter(Boolean).join("\n");
  return {
    node_id: summaryNodeId(first.session_id, depth, "nodes", sourceIds),
    session_id: first.session_id,
    depth,
    summary_text: summaryText,
    token_count: estimateTokenCount(summaryText),
    source_token_count: sorted.reduce((sum, node) => sum + node.source_token_count, 0),
    source_type: "nodes",
    source_ids: sourceIds,
    source_event_ids: sourceEventIds,
    earliest_at: first.earliest_at,
    latest_at: latest.latest_at,
    created_at: latest.latest_at,
    cwd: latest.cwd,
    ...(latest.repo_root ? { repo_root: latest.repo_root } : first.repo_root ? { repo_root: first.repo_root } : {}),
    ...(latest.git_branch ? { git_branch: latest.git_branch } : first.git_branch ? { git_branch: first.git_branch } : {}),
    topics,
  };
}

export function buildSessionMemorySummary(events: NormalizedEvent[]): SessionMemorySummary {
  const sorted = [...events].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  const sessionId = sorted[0]?.session_id ?? "";
  const latest = sorted.at(-1);
  const prompts = sorted
    .filter((event) => event.hook_event === "UserPromptSubmit" || event.hook_event === "Note")
    .map(eventSignalText)
    .filter((text) => text.length > 0);
  const outcomes = sorted
    .filter((event) => event.hook_event === "Stop" || event.hook_event === "PreCompact")
    .map(eventSignalText)
    .filter((text) => text.length > 0);
  const tools = uniqueStrings(sorted
    .map((event) => event.tool_name || stringField(event.payload.tool_name) || stringField(event.payload.toolName))
    .filter((tool): tool is string => typeof tool === "string" && tool.length > 0 && !tool.startsWith("mcp__codex_lcm__")))
    .slice(0, 8);
  const signalTexts = [...prompts, ...outcomes];
  const topics = extractTopics(signalTexts);
  const title = titleFromText(prompts.at(-1) || prompts[0] || outcomes.at(-1) || latest?.hook_event || "Codex session");
  const overview = overviewFromSignals(prompts, outcomes);
  const sourceEventIds = sorted
    .filter((event) => isSummarySourceEvent(event))
    .map((event) => event.event_id);
  return {
    session_id: sessionId,
    updated_at: latest?.timestamp ?? new Date(0).toISOString(),
    cwd: latest?.cwd ?? sorted[0]?.cwd ?? "",
    ...(latest?.repo_root ? { repo_root: latest.repo_root } : sorted[0]?.repo_root ? { repo_root: sorted[0].repo_root } : {}),
    ...(latest?.git_branch ? { git_branch: latest.git_branch } : sorted[0]?.git_branch ? { git_branch: sorted[0].git_branch } : {}),
    title,
    overview,
    topics,
    key_prompts: takeHeadTail(prompts.map(compactWhitespace).map((text) => truncateText(text, 120)), 5, 3),
    outcomes: outcomes.map(compactWhitespace).map((text) => truncateText(text, 120)).slice(-5),
    tools,
    source_event_ids: sourceEventIds.length > 0
      ? takeHeadTail(sourceEventIds, SUMMARY_SOURCE_EVENT_LIMIT, Math.ceil(SUMMARY_SOURCE_EVENT_LIMIT / 2))
      : takeHeadTail(sorted.map((event) => event.event_id), 6, 3),
  };
}

export function eventSignalText(event: NormalizedEvent): string {
  if (event.hook_event === "UserPromptSubmit") {
    return stringField(event.payload.prompt) || stringField(event.payload.message) || "";
  }
  if (event.hook_event === "Note") {
    return stringField(event.payload.note) || stringField(event.payload.text) || "";
  }
  if (event.hook_event === "Stop") {
    return stringField(event.payload.last_assistant_message) || stringField(event.payload.summary) || "";
  }
  if (event.hook_event === "PreCompact") {
    return stringField(event.payload.summary) || stringField(event.payload.reason) || "";
  }
  return "";
}

export function isSummarySourceEvent(event: NormalizedEvent): boolean {
  if (isGeneratedSuggestionEvent(event)) return false;
  return event.hook_event === "UserPromptSubmit" ||
    event.hook_event === "Note" ||
    event.hook_event === "Stop" ||
    event.hook_event === "PreCompact";
}

export function isGeneratedSuggestionEvent(event: NormalizedEvent): boolean {
  const signal = eventSignalText(event);
  if (event.hook_event === "UserPromptSubmit") {
    return /^#\s*overview\s+generate\s+0\s+to\s+3\s+hyperpersonalized\s+suggestions\s+for\s+what\s+this\s+user\s+can\s+do\s+with\s+codex\b/iu.test(signal);
  }
  if (event.hook_event === "Stop") {
    return isSuggestionJson(signal);
  }
  return false;
}

function isSuggestionJson(text: string): boolean {
  if (!text.trimStart().startsWith("{")) return false;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    return Array.isArray(record.suggestions) && Object.keys(record).every((key) => key === "suggestions");
  } catch {
    return false;
  }
}

export function takeHeadTail<T>(values: T[], limit: number, headCount: number): T[] {
  if (values.length <= limit) return values;
  const head = values.slice(0, headCount);
  const tail = values.slice(-(limit - head.length));
  return [...head, ...tail];
}

export function estimateTokenCount(text: string): number {
  return Math.max(1, Math.ceil(compactWhitespace(text).length / 4));
}

function toStrictFtsQuery(query: string): string {
  return query
    .split(/\s+/u)
    .map(quoteFtsTerm)
    .join(" AND ");
}

function toRelaxedFtsQuery(query: string): string | undefined {
  const terms = queryTerms(query);
  if (terms.length < 2) return undefined;
  return terms.map(quoteFtsTerm).join(" OR ");
}

function quoteFtsTerm(term: string): string {
  return `"${term.replaceAll('"', '""')}"`;
}

function queryTerms(query: string): string[] {
  return signalTerms(query, 12, true);
}

function signalTerms(text: string, limit: number, unique: boolean): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const term of text.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const normalized = term.replace(/^-+|-+$/gu, "");
    if (!isSignalTerm(normalized)) continue;
    if (unique && seen.has(normalized)) continue;
    seen.add(normalized);
    terms.push(normalized);
    if (terms.length >= limit) break;
  }
  return terms;
}

function isSignalTerm(term: string): boolean {
  if (term.length < 2) return false;
  if (COMMON_FUNCTION_TERMS.has(term)) return false;
  if (/^\d+$/u.test(term)) return term.length >= 4;
  if (term.includes("-") || /\d/u.test(term)) return true;
  return term.length >= 3;
}

function summaryNodeRank(node: SummaryNode, terms: string[]): {
  focusedHits: number;
  directness: number;
  fullHits: number;
  evidenceSupport: number;
} {
  return {
    focusedHits: queryTermHitCountFromTerms(summaryNodeFocusedSearchText(node), terms),
    directness: summaryNodeDirectness(node, terms),
    fullHits: queryTermHitCountFromTerms(summaryNodeSearchText(node), terms),
    evidenceSupport: summaryNodeEvidenceSupport(node),
  };
}

function queryTermHitCountFromTerms(text: string, terms: string[]): number {
  const lowered = text.toLowerCase();
  return terms.filter((term) => textContainsTerm(lowered, term)).length;
}

function textContainsTerm(loweredText: string, term: string): boolean {
  if (loweredText.includes(term)) return true;
  if (!/[-_]/u.test(term)) return false;
  const normalizedText = loweredText.replace(/[-_]+/gu, " ");
  const normalizedTerm = term.replace(/[-_]+/gu, " ");
  return normalizedText.includes(normalizedTerm);
}

function summaryNodeFocusedSearchText(node: SummaryNode): string {
  return [
    summaryNodeTitle(node),
    ...node.topics,
  ].join("\n");
}

function summaryNodeDirectness(node: SummaryNode, terms: string[]): number {
  if (terms.length === 0) return 0;
  const focusText = summaryNodeTitle(node).toLowerCase();
  const topicText = node.topics.join(" ").toLowerCase();
  return directnessScore(focusText, terms, 5) + directnessScore(topicText, terms, 2.5);
}

function directnessScore(loweredText: string, terms: string[], uniqueHitWeight: number): number {
  let uniqueHits = 0;
  let totalHits = 0;
  for (const term of terms) {
    const matches = termOccurrenceCount(loweredText, term);
    if (matches === 0) continue;
    uniqueHits += 1;
    totalHits += matches;
  }
  const repetitionPenalty = Math.min(Math.max(0, totalHits - uniqueHits), 6);
  return uniqueHits * uniqueHitWeight - repetitionPenalty;
}

function termOccurrenceCount(loweredText: string, term: string): number {
  const directCount = countOccurrences(loweredText, term);
  if (directCount > 0) return directCount;
  if (!/[-_]/u.test(term)) return 0;
  return countOccurrences(loweredText.replace(/[-_]+/gu, " "), term.replace(/[-_]+/gu, " "));
}

function countOccurrences(haystack: string, needle: string): number {
  if (haystack.length === 0 || needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function summaryNodeEvidenceSupport(node: SummaryNode): number {
  const sourceCount = Math.max(node.source_ids.length, node.source_event_ids.length);
  const sourceBreadth = Math.min(8, Math.log2(sourceCount + 1));
  const tokenBreadth = Math.min(8, Math.log2(Math.max(1, node.source_token_count) / 120 + 1));
  return sourceBreadth * 2 + tokenBreadth;
}

function overviewFromSignals(prompts: string[], outcomes: string[]): string {
  const parts: string[] = [];
  if (prompts.at(-1)) parts.push(`User focus: ${truncateText(compactWhitespace(prompts.at(-1) ?? ""), 220)}`);
  if (outcomes[0]) parts.push(`Latest outcome: ${truncateText(compactWhitespace(outcomes.at(-1) ?? outcomes[0]), 220)}`);
  return parts.length > 0 ? parts.join(" ") : "No high-signal user prompt or assistant outcome has been captured yet.";
}

function titleFromText(text: string): string {
  const compact = compactWhitespace(text)
    .replace(/^please\s+/iu, "")
    .replace(/^(can you|could you|do you|does this)\s+/iu, "");
  return truncateText(compact, 88) || "Codex session";
}

function extractTopics(inputSignals: string[]): string[] {
  const signals = inputSignals.filter((text) => text.trim().length > 0);
  const latestSignalIndex = Math.max(0, signals.length - 1);
  const stats = new Map<string, { count: number; firstSeen: number; lastSeen: number }>();
  let termOrder = 0;
  for (const [signalIndex, signal] of signals.entries()) {
    for (const term of signalTerms(signal, 80, false)) {
      const existing = stats.get(term);
      if (existing) {
        existing.count += 1;
        existing.lastSeen = signalIndex;
      } else {
        stats.set(term, { count: 1, firstSeen: termOrder, lastSeen: signalIndex });
      }
      termOrder += 1;
    }
  }
  return [...stats.entries()]
    .sort((a, b) =>
      topicScore(b[0], b[1], latestSignalIndex) - topicScore(a[0], a[1], latestSignalIndex) ||
      b[1].lastSeen - a[1].lastSeen ||
      a[1].firstSeen - b[1].firstSeen)
    .map(([term]) => term)
    .slice(0, 16);
}

function topicScore(term: string, stat: { count: number; firstSeen: number; lastSeen: number }, latestSignalIndex: number): number {
  const shapeBonus = (term.includes("-") ? 4 : 0) + (/\d/u.test(term) ? 3 : 0);
  const cappedFrequency = Math.min(stat.count, 2) * 6;
  const recencyBonus = stat.lastSeen === latestSignalIndex ? 8 : 0;
  return cappedFrequency + shapeBonus + recencyBonus;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function compactWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

function truncateText(text: string, maxChars: number): string {
  const compact = compactWhitespace(text);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function shortSourceId(eventId: string): string {
  return eventId.length > 12 ? eventId.slice(0, 12) : eventId;
}

function summaryNodeId(sessionId: string, depth: number, sourceType: SummarySourceType, sourceIds: string[]): string {
  const hash = createHash("sha256")
    .update(`${sessionId}\n${depth}\n${sourceType}\n${sourceIds.join("\n")}`)
    .digest("hex")
    .slice(0, 24);
  return `summary:${sessionId}:d${depth}:${hash}`;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
