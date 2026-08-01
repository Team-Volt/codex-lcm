import { decodePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";
import { parseStringArray, recordValue, rowToSessionSummary } from "./storage-rows.ts";
import type { SessionDiscovery, SessionSearchMatch, SessionSummary } from "./storage-types.ts";
import { eventSignalText, isGeneratedSuggestionEvent, isSummarySourceEvent, queryTermHitCount } from "./summary.ts";

export function rankSessionRows(rows: unknown[], query: string): SessionSummary[] {
  const evidenceRows = strongestSessionEvidenceRows(rows, query);
  const sessions = new Map<string, {
    summary: SessionSummary;
    score: number;
    matchCount: number;
    lastMatchAt: string;
    firstOrder: number;
    bestMatch?: SessionSearchMatch;
  }>();
  evidenceRows.forEach((row, order) => {
    const record = recordValue(row);
    const sessionId = String(record.session_id);
    const matchAt = String(record.match_timestamp ?? record.last_seen ?? "");
    const matchText = typeof record.match_text === "string" ? record.match_text : "";
    const weight = typeof record.match_weight === "number" ? record.match_weight : 1;
    const rowScore = queryTermHitCount(matchText, query) * weight;
    const bestMatch = rowToSessionSearchMatch(record, query, rowScore);
    const existing = sessions.get(sessionId);
    if (!existing) {
      sessions.set(sessionId, {
        summary: rowToSessionSummary(row),
        score: rowScore,
        matchCount: 1,
        lastMatchAt: matchAt,
        firstOrder: order,
        bestMatch,
      });
      return;
    }
    existing.score += rowScore;
    existing.matchCount += 1;
    if (matchAt > existing.lastMatchAt) existing.lastMatchAt = matchAt;
    if (bestMatch && (!existing.bestMatch || compareSearchMatches(bestMatch, existing.bestMatch) < 0)) {
      existing.bestMatch = bestMatch;
    }
  });
  return [...sessions.values()]
    .map((entry) => ({
      ...entry,
      discovery: sessionDiscovery(entry, query),
    }))
    .sort((a, b) =>
      b.discovery.score - a.discovery.score ||
      b.score - a.score ||
      (b.bestMatch?.score ?? 0) - (a.bestMatch?.score ?? 0) ||
      b.matchCount - a.matchCount ||
      b.lastMatchAt.localeCompare(a.lastMatchAt) ||
      a.firstOrder - b.firstOrder)
    .map((entry) => ({
      ...entry.summary,
      match_count: entry.matchCount,
      ...(entry.bestMatch ? { best_match: entry.bestMatch } : {}),
      discovery: entry.discovery,
    }));
}

export function strongestSessionEvidenceRows(rows: unknown[], query: string): unknown[] {
  const scores = new Map<string, Map<SessionSearchMatch["kind"], { score: number; matchCount: number }>>();
  for (const row of rows) {
    const record = recordValue(row);
    const kind = searchMatchKind(record.match_kind);
    if (!kind) continue;
    const sessionId = String(record.session_id);
    const sessionScores = scores.get(sessionId) ?? new Map();
    const evidence = sessionScores.get(kind) ?? { score: 0, matchCount: 0 };
    const matchText = typeof record.match_text === "string" ? record.match_text : "";
    const weight = typeof record.match_weight === "number" ? record.match_weight : 1;
    evidence.score += queryTermHitCount(matchText, query) * weight;
    evidence.matchCount += 1;
    sessionScores.set(kind, evidence);
    scores.set(sessionId, sessionScores);
  }

  const selectedKinds = new Map<string, SessionSearchMatch["kind"]>();
  for (const [sessionId, sessionScores] of scores) {
    const selected = [...sessionScores.entries()].sort((left, right) =>
      right[1].score - left[1].score ||
      right[1].matchCount - left[1].matchCount ||
      searchMatchKindWeight(right[0]) - searchMatchKindWeight(left[0]))[0];
    if (selected) selectedKinds.set(sessionId, selected[0]);
  }

  return rows.filter((row) => {
    const record = recordValue(row);
    return selectedKinds.get(String(record.session_id)) === searchMatchKind(record.match_kind);
  });
}

export function sessionDiscovery(entry: {
  summary: SessionSummary;
  score: number;
  matchCount: number;
  bestMatch?: SessionSearchMatch;
}, query: string): SessionDiscovery {
  let score = entry.score;
  const reasons: string[] = [];
  const match = entry.bestMatch;

  if (match?.kind === "summary_node") {
    score += 10;
    reasons.push("summary-node match");
  } else if (match?.kind === "session_summary") {
    score += 6;
    reasons.push("session-summary match");
  } else if (match?.kind === "event") {
    reasons.push("raw-event match");
  }

  const sourceEventCount = match?.source_event_count ?? 0;
  if (sourceEventCount >= 4) {
    score += 12;
    reasons.push("source-rich summary");
  } else if (sourceEventCount >= 2) {
    score += 6;
    reasons.push("multiple source events");
  }

  const sourceTokenCount = match?.source_token_count ?? 0;
  if (sourceTokenCount >= 600) {
    score += 8;
    reasons.push("substantive source text");
  } else if (sourceTokenCount >= 160) {
    score += 4;
    reasons.push("nontrivial source text");
  }

  if (entry.summary.event_count >= 8) {
    score += 8;
    reasons.push("longer session");
  } else if (entry.summary.event_count >= 3) {
    score += 4;
    reasons.push("multi-event session");
  } else if (entry.summary.event_count >= 2) {
    score += 2;
    reasons.push("prompt-outcome session");
  }

  if (entry.matchCount >= 2) {
    score += Math.min(entry.matchCount, 4) * 2;
    reasons.push("multiple matches");
  }

  if (isBroadDiscoveryQuery(query) && entry.summary.event_count <= 1) {
    score -= 24;
    reasons.push("tiny session penalty");
  }

  const confidence = score >= 34 ? "high" : score >= 18 ? "medium" : "low";
  return {
    confidence,
    score,
    reasons,
  };
}

export function isSearchDiscoveryRow(row: unknown, query: string): boolean {
  const record = recordValue(row);
  if (searchMatchKind(record.match_kind) !== "event") return true;
  if (typeof record.match_text !== "string") return true;
  try {
    return isSearchDiscoveryEvent(decodePersistedEvent(record.match_text), query);
  } catch {
    return true;
  }
}

export function isSearchDiscoveryEvent(event: NormalizedEvent, query: string): boolean {
  if (isGeneratedSuggestionEvent(event)) return isExplicitSuggestionQuery(query);
  return isSummarySourceEvent(event);
}

export function isExplicitSuggestionQuery(query: string): boolean {
  return /\b(hyperpersonalized|suggestion|suggestions)\b/iu.test(query);
}

export function isBroadDiscoveryQuery(query: string): boolean {
  return discoveryQueryTermCount(query) >= 4;
}

export function discoveryQueryTermCount(query: string): number {
  const terms = new Set<string>();
  for (const term of query.toLowerCase().split(/[^\p{L}\p{N}_-]+/u)) {
    const normalized = term.replace(/^-+|-+$/gu, "");
    if (normalized.length >= 3 || /[-_]/u.test(normalized) || /\d/u.test(normalized)) {
      terms.add(normalized);
    }
  }
  return terms.size;
}

export function rowToSessionSearchMatch(record: Record<string, unknown>, query: string, score: number): SessionSearchMatch | undefined {
  const kind = searchMatchKind(record.match_kind);
  if (!kind) return undefined;
  const text = searchMatchText(kind, record.match_text);
  const snippet = bestMatchSnippet(text, query);
  if (snippet.length === 0) return undefined;
  const topics = parseStringArray(record.match_topics_json);
  const sourceEventCount = parseStringArray(record.match_source_event_ids_json).length;
  const sourceTokenCount = Number(record.match_source_token_count ?? 0);
  return {
    kind,
    snippet,
    timestamp: String(record.match_timestamp ?? ""),
    score,
    ...(typeof record.match_node_id === "string" && record.match_node_id.length > 0 ? { node_id: record.match_node_id } : {}),
    ...(typeof record.match_event_id === "string" && record.match_event_id.length > 0 ? { event_id: record.match_event_id } : {}),
    ...(record.match_depth !== undefined ? { depth: Number(record.match_depth) } : {}),
    ...(topics.length > 0 ? { topics: topics.slice(0, 12) } : {}),
    ...(sourceEventCount > 0 ? { source_event_count: sourceEventCount } : {}),
    ...(sourceTokenCount > 0 ? { source_token_count: sourceTokenCount } : {}),
  };
}

export function searchMatchKind(value: unknown): SessionSearchMatch["kind"] | undefined {
  if (value === "summary_node" || value === "session_summary" || value === "event") return value;
  return undefined;
}

export function searchMatchText(kind: SessionSearchMatch["kind"], value: unknown): string {
  if (typeof value !== "string") return "";
  if (kind !== "event") return value;
  try {
    const event = decodePersistedEvent(value);
    return eventSignalText(event) || `${event.hook_event}: ${JSON.stringify(event.payload)}`;
  } catch {
    return value;
  }
}

export function compareSearchMatches(a: SessionSearchMatch, b: SessionSearchMatch): number {
  return b.score - a.score ||
    searchMatchKindWeight(b.kind) - searchMatchKindWeight(a.kind) ||
    b.timestamp.localeCompare(a.timestamp);
}

export function searchMatchKindWeight(kind: SessionSearchMatch["kind"]): number {
  if (kind === "summary_node") return 3;
  if (kind === "session_summary") return 2;
  return 1;
}

export function bestMatchSnippet(text: string, query: string, maxChars = 220): string {
  const compactText = compactWhitespace(text);
  if (compactText.length === 0) return "";
  const scoredLines = text.split(/\r?\n/u)
    .map(compactWhitespace)
    .filter((line) => line.length > 0)
    .map((line, index) => ({ line, index, hits: queryTermHitCount(line, query) }));
  const candidates = scoredLines.some((line) => line.hits > 0 && !line.line.startsWith("Topics:"))
    ? scoredLines.filter((line) => line.hits > 0 && !line.line.startsWith("Topics:"))
    : scoredLines;
  const bestLine = candidates
    .sort((a, b) => b.hits - a.hits || a.index - b.index)[0]?.line ?? compactText;
  return queryFocusedSnippet(bestLine, query, maxChars);
}

export function queryFocusedSnippet(text: string, query: string, maxChars: number): string {
  const compact = compactWhitespace(text);
  if (compact.length <= maxChars) return compact;
  const phrase = compactWhitespace(query).toLowerCase();
  const matchIndex = compact.toLowerCase().indexOf(phrase);
  if (matchIndex < 0 || maxChars < 10) return truncateSnippet(compact, maxChars);
  const contentLength = maxChars - 6;
  const start = Math.max(0, Math.min(matchIndex - Math.floor(contentLength / 3), compact.length - contentLength));
  const end = Math.min(compact.length, start + contentLength);
  return `${start > 0 ? "..." : ""}${compact.slice(start, end)}${end < compact.length ? "..." : ""}`;
}

export function truncateSnippet(text: string, maxChars: number): string {
  const compact = compactWhitespace(text);
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

export function compactWhitespace(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function clampLimit(limit: number | undefined, fallback: number, max = 200): number {
  return Math.min(Math.max(Number(limit ?? fallback), 1), max);
}

export function positiveInteger(value: number | undefined, fallback: number): number {
  const parsed = Number(value ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}
