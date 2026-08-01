import type { NormalizedEvent } from "./events.ts";
import { bestMatchSnippet, compactWhitespace, truncateSnippet } from "./storage-search.ts";
import { extractEventMetadata } from "./storage-sessions.ts";
import type { ContextPlan, ContextPlanState, GraphNode, SessionSummary } from "./storage-types.ts";
import {
  HISTORICAL_SOURCE_TEXT_NOTICE,
  eventSignalText,
  queryTermHitCount,
  quoteHistoricalText,
  rankSummaryNodesForContext,
  summaryNodeSearchText,
  type SummaryNode,
} from "./summary.ts";

export function rankContextEvents(events: NormalizedEvent[], query: string): NormalizedEvent[] {
  const phrase = compactWhitespace(query).toLowerCase();
  return [...events].sort((a, b) => {
    const aText = eventSignalText(a);
    const bText = eventSignalText(b);
    const exactDifference = Number(bText.toLowerCase().includes(phrase)) - Number(aText.toLowerCase().includes(phrase));
    return exactDifference ||
      queryTermHitCount(bText, query) - queryTermHitCount(aText, query) ||
      b.timestamp.localeCompare(a.timestamp) ||
      b.event_id.localeCompare(a.event_id);
  });
}

export function contextEventToMarkdown(event: NormalizedEvent, query: string, heading: string): string {
  const signal = eventSignalText(event);
  if (signal.length === 0) return "";
  const snippet = query.length > 0 ? bestMatchSnippet(signal, query, 280) : truncateSnippet(signal, 280);
  return [
    `## ${event.timestamp} ${heading}`,
    `session: ${event.session_id}`,
    `event: ${event.event_id}`,
    HISTORICAL_SOURCE_TEXT_NOTICE,
    quoteHistoricalText(snippet),
    `hook: ${event.hook_event}`,
    "",
  ].join("\n");
}

export function buildContextPlan(args: {
  session?: SessionSummary;
  modelContextWindow: number;
  autoCompactTokenLimit: number;
  recentEventLimit: number;
  estimatedRecentTokens: number;
  estimatedSummaryTokens: number;
  summaryNodeCount: number;
  latestEventAt: string | null;
}): ContextPlan {
  const estimatedTotalTokens = args.estimatedRecentTokens + args.estimatedSummaryTokens;
  const state = contextPlanState(estimatedTotalTokens, args.autoCompactTokenLimit, args.modelContextWindow);
  const suggestedTools = state === "under_limit" || state === "empty"
    ? ["lcm_context_plan"]
    : ["lcm_context_plan", "lcm_pack_context", "lcm_expand_query"];
  return {
    ...(args.session ? {
      session_id: args.session.session_id,
      cwd: args.session.cwd,
      ...(args.session.repo_root ? { repo_root: args.session.repo_root } : {}),
    } : {}),
    model_context_window: args.modelContextWindow,
    auto_compact_token_limit: args.autoCompactTokenLimit,
    recent_event_limit: args.recentEventLimit,
    estimated_recent_tokens: args.estimatedRecentTokens,
    estimated_summary_tokens: args.estimatedSummaryTokens,
    estimated_total_tokens: estimatedTotalTokens,
    summary_node_count: args.summaryNodeCount,
    latest_event_at: args.latestEventAt,
    state,
    recommendation: contextPlanRecommendation(state, args.summaryNodeCount),
    suggested_tools: suggestedTools,
    can_control_compaction: false,
  };
}

function contextPlanState(estimatedRecentTokens: number, autoCompactTokenLimit: number, modelContextWindow: number): ContextPlanState {
  if (estimatedRecentTokens <= 0) return "empty";
  if (estimatedRecentTokens >= modelContextWindow) return "over_context";
  if (estimatedRecentTokens >= autoCompactTokenLimit) return "over_limit";
  if (estimatedRecentTokens >= Math.floor(autoCompactTokenLimit * 0.8)) return "near_limit";
  return "under_limit";
}

function contextPlanRecommendation(state: ContextPlanState, summaryNodeCount: number): string {
  if (state === "empty") return "No matching session found.";
  if (state === "under_limit") return "No context packing needed yet.";
  if (summaryNodeCount === 0) return "Context pressure is high, but no summary nodes are available yet.";
  if (state === "near_limit") return "Near the soft context limit; use lcm_pack_context for broad recall before continuing.";
  if (state === "over_context") return "Estimated recent context is past the model window; use lcm_pack_context or lcm_expand_query for focused recovery.";
  return "Past the soft context limit; use lcm_pack_context or lcm_expand_query before relying on raw recent context.";
}

export function rankQueryExpansionNodes(nodes: SummaryNode[], query: string, overview: boolean): SummaryNode[] {
  const ranked = rankSummaryNodesForContext(nodes, query);
  if (!overview) return ranked;
  return ranked.sort((left, right) =>
    right.depth - left.depth ||
    Number(right.source_type === "nodes") - Number(left.source_type === "nodes") ||
    right.source_ids.length - left.source_ids.length ||
    queryTermHitCount(summaryNodeSearchText(right), query) - queryTermHitCount(summaryNodeSearchText(left), query) ||
    right.latest_at.localeCompare(left.latest_at) ||
    right.node_id.localeCompare(left.node_id));
}

export function focusedExcerpt(value: string, query: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (value.length <= maxChars) return value;
  const terms = query.toLowerCase().split(/[^a-z0-9_-]+/u).filter((term) => term.length > 0);
  const lowerValue = value.toLowerCase();
  const hit = terms
    .map((term) => lowerValue.indexOf(term))
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0] ?? 0;
  const prefix = hit > 0 ? "..." : "";
  const suffix = hit + maxChars < value.length ? "..." : "";
  const bodyBudget = Math.max(0, maxChars - prefix.length - suffix.length);
  const start = Math.max(0, Math.min(hit, value.length - bodyBudget));
  return `${prefix}${value.slice(start, start + bodyBudget)}${suffix}`;
}

export function parseCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const value = Number.parseInt(cursor, 10);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

export function parseTimestamp(value: string | undefined, name: string): string | undefined {
  if (!value) return undefined;
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new Error(`${name} must be a valid ISO-8601 timestamp.`);
  return timestamp.toISOString();
}

export function eventSearchText(event: NormalizedEvent): string {
  const metadata = extractEventMetadata(event);
  return [
    event.hook_event,
    event.session_id,
    event.cwd,
    event.repo_root,
    event.git_branch,
    event.tool_name,
    metadata.turn_id,
    metadata.tool_use_id,
    JSON.stringify(event.payload),
  ].filter(Boolean).join("\n");
}

export function checkpointToMarkdown(node: GraphNode): string {
  return [
    `## ${node.timestamp} Checkpoint`,
    `session: ${node.session_id}`,
    `cwd: ${node.cwd}`,
    JSON.stringify(node.metadata),
    "",
  ].join("\n");
}

function uniqueEvents(events: NormalizedEvent[]): NormalizedEvent[] {
  const seen = new Set<string>();
  const result: NormalizedEvent[] = [];
  for (const event of events) {
    if (seen.has(event.event_id)) continue;
    seen.add(event.event_id);
    result.push(event);
  }
  return result;
}
