import type { NormalizedEvent } from "./events.ts";
import { isRecord } from "./storage-rows.ts";
import { eventSignalText, isGeneratedSuggestionEvent, isSummarySourceEvent, type SessionMemorySummary } from "./summary.ts";
import type { SessionListSummary, SessionSummary, UsageReport } from "./storage-types.ts";

export function sortedSessionIds(sessionIds: Iterable<string>): string[] {
  return Array.from(new Set(sessionIds)).sort((left, right) => left.localeCompare(right));
}

export function sessionListSummary(summary: SessionMemorySummary): SessionListSummary {
  return {
    updated_at: summary.updated_at,
    title: summary.title,
    overview: summary.overview,
    topics: summary.topics,
    key_prompts: summary.key_prompts,
    outcomes: summary.outcomes,
    source_event_count: summary.source_event_ids.length,
  };
}

export function sessionsWithDescendants(allSessions: SessionSummary[], roots: SessionSummary[]): SessionSummary[] {
  const byParent = new Map<string, SessionSummary[]>();
  for (const session of allSessions) {
    if (!session.parent_session_id) continue;
    const children = byParent.get(session.parent_session_id) ?? [];
    children.push(session);
    byParent.set(session.parent_session_id, children);
  }
  const selected = new Map<string, SessionSummary>();
  const queue = [...roots];
  while (queue.length > 0) {
    const session = queue.shift();
    if (!session || selected.has(session.session_id)) continue;
    selected.set(session.session_id, session);
    queue.push(...(byParent.get(session.session_id) ?? []));
  }
  return [...selected.values()];
}

export function summarizeSessions(events: NormalizedEvent[]): SessionSummary[] {
  const sessions = new Map<string, SessionSummary>();
  for (const event of events) {
    const metadata = extractSessionMetadata(event);
    const existing = sessions.get(event.session_id);
    if (!existing) {
      sessions.set(event.session_id, {
        session_id: event.session_id,
        first_seen: event.timestamp,
        last_seen: event.timestamp,
        cwd: event.cwd,
        ...(event.repo_root ? { repo_root: event.repo_root } : {}),
        ...(event.git_branch ? { git_branch: event.git_branch } : {}),
        event_count: 1,
        match_count: 1,
        ...metadata,
      });
      continue;
    }
    existing.first_seen = event.timestamp < existing.first_seen ? event.timestamp : existing.first_seen;
    existing.last_seen = event.timestamp > existing.last_seen ? event.timestamp : existing.last_seen;
    existing.cwd = event.cwd;
    existing.repo_root = event.repo_root ?? existing.repo_root;
    existing.git_branch = event.git_branch ?? existing.git_branch;
    existing.event_count += 1;
    existing.match_count = (existing.match_count ?? 0) + 1;
    existing.parent_session_id = metadata.parent_session_id ?? existing.parent_session_id;
    existing.agent_role = metadata.agent_role ?? existing.agent_role;
    existing.agent_nickname = metadata.agent_nickname ?? existing.agent_nickname;
    existing.model = metadata.model ?? existing.model;
    existing.reasoning_effort = metadata.reasoning_effort ?? existing.reasoning_effort;
    existing.total_input_tokens = maxOptional(existing.total_input_tokens, metadata.total_input_tokens);
    existing.cached_input_tokens = maxOptional(existing.cached_input_tokens, metadata.cached_input_tokens);
    existing.output_tokens = maxOptional(existing.output_tokens, metadata.output_tokens);
    existing.reasoning_output_tokens = maxOptional(existing.reasoning_output_tokens, metadata.reasoning_output_tokens);
    existing.total_tokens = maxOptional(existing.total_tokens, metadata.total_tokens);
  }
  return [...sessions.values()].sort((a, b) => b.last_seen.localeCompare(a.last_seen));
}

export function extractEventMetadata(event: NormalizedEvent): { turn_id?: string; tool_use_id?: string } {
  return {
    turn_id: stringField(event.payload.turn_id) || stringField(event.payload.turnId),
    tool_use_id: stringField(event.payload.tool_use_id) || stringField(event.payload.toolUseId),
  };
}

export function extractSessionMetadata(event: NormalizedEvent): Partial<SessionSummary> {
  const usage = recordField(event.payload.usage);
  const importedMetadata = recordField(event.payload.metadata);
  const inferredParentId = stringField(event.payload.parent_session_id) ||
    parentSessionId(importedMetadata) ||
    delegatedParentSessionId(event);
  return {
    ...(inferredParentId ? { parent_session_id: inferredParentId } : {}),
    ...(stringField(event.payload.agent_role) || stringField(importedMetadata?.agent_role)
      ? { agent_role: stringField(event.payload.agent_role) || stringField(importedMetadata?.agent_role) }
      : {}),
    ...(stringField(event.payload.agent_nickname) || stringField(importedMetadata?.agent_nickname)
      ? { agent_nickname: stringField(event.payload.agent_nickname) || stringField(importedMetadata?.agent_nickname) }
      : {}),
    ...(stringField(event.payload.model) ? { model: stringField(event.payload.model) } : {}),
    ...(stringField(event.payload.reasoning_effort) ? { reasoning_effort: stringField(event.payload.reasoning_effort) } : {}),
    ...(numberField(usage?.input_token_count) !== undefined ? { total_input_tokens: numberField(usage?.input_token_count) } : {}),
    ...(numberField(usage?.cached_input_token_count) !== undefined
      ? { cached_input_tokens: numberField(usage?.cached_input_token_count) }
      : {}),
    ...(numberField(usage?.output_token_count) !== undefined ? { output_tokens: numberField(usage?.output_token_count) } : {}),
    ...(numberField(usage?.reasoning_output_token_count) !== undefined
      ? { reasoning_output_tokens: numberField(usage?.reasoning_output_token_count) }
      : {}),
    ...(numberField(usage?.total_token_count) !== undefined ? { total_tokens: numberField(usage?.total_token_count) } : {}),
  };
}

export function delegatedParentSessionId(event: NormalizedEvent): string | undefined {
  if (event.hook_event !== "UserPromptSubmit") return undefined;
  const prompt = eventSignalText(event).trimStart();
  if (!prompt.startsWith("<codex_delegation>")) return undefined;
  const match = /<source_thread_id>\s*([^<\s]+)\s*<\/source_thread_id>/iu.exec(prompt);
  return stringField(match?.[1]);
}

export function parentSessionId(metadata: Record<string, unknown> | undefined): string | undefined {
  const direct = stringField(metadata?.parent_thread_id);
  if (direct) return direct;
  const source = recordField(metadata?.source);
  const subagent = recordField(source?.subagent);
  return stringField(recordField(subagent?.thread_spawn)?.parent_thread_id);
}

export function recordField(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export function maxOptional(current: number | undefined, incoming: number | undefined): number | undefined {
  if (incoming === undefined) return current;
  if (current === undefined) return incoming;
  return Math.max(current, incoming);
}

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function maxNullable(current: string, incoming: string): string {
  return `CASE WHEN ${incoming} IS NULL THEN ${current} WHEN ${current} IS NULL OR ${incoming} > ${current} THEN ${incoming} ELSE ${current} END`;
}

export function usageFromSessions(sessions: SessionSummary[]): UsageReport {
  return {
    totals: sessions.reduce((totals, session) => ({
      sessions: totals.sessions + 1,
      input_tokens: totals.input_tokens + (session.total_input_tokens ?? 0),
      cached_input_tokens: totals.cached_input_tokens + (session.cached_input_tokens ?? 0),
      output_tokens: totals.output_tokens + (session.output_tokens ?? 0),
      reasoning_output_tokens: totals.reasoning_output_tokens + (session.reasoning_output_tokens ?? 0),
      total_tokens: totals.total_tokens + (session.total_tokens ?? 0),
    }), {
      sessions: 0,
      input_tokens: 0,
      cached_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
      total_tokens: 0,
    }),
  };
}

export function usageReportFromRow(row: Record<string, unknown>): UsageReport {
  return {
    totals: {
      sessions: Number(row.sessions),
      input_tokens: Number(row.input_tokens),
      cached_input_tokens: Number(row.cached_input_tokens),
      output_tokens: Number(row.output_tokens),
      reasoning_output_tokens: Number(row.reasoning_output_tokens),
      total_tokens: Number(row.total_tokens),
    },
  };
}

export function isCodexLcmToolEvent(event: NormalizedEvent): boolean {
  const toolName = event.tool_name || stringField(event.payload.tool_name) || stringField(event.payload.toolName);
  return toolName?.startsWith("mcp__codex_lcm__") ?? false;
}

export function isSearchIndexEvent(event: NormalizedEvent): boolean {
  return isSummarySourceEvent(event) || isGeneratedSuggestionEvent(event);
}

export function isSummaryHook(hookEvent: string): boolean {
  return hookEvent === "UserPromptSubmit" ||
    hookEvent === "Note" ||
    hookEvent === "Stop" ||
    hookEvent === "PreCompact" ||
    hookEvent === "PostCompact";
}
