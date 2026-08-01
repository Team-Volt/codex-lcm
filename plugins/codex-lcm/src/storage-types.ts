import type { LcmConfig } from "./config.ts";
import type { NormalizedEvent } from "./events.ts";
import type { FileReference } from "./file-refs.ts";
import type { OverflowContent } from "./overflow.ts";
import type { SessionMemorySummary, SummaryNode } from "./summary.ts";

export type { FileReference } from "./file-refs.ts";
export type { OverflowContent, OverflowReference, OverflowSearchMatch } from "./overflow.ts";
export type { SessionMemorySummary, SummaryNode, SummarySourceType } from "./summary.ts";

export type StorageOptions = {
  home?: string;
  config?: LcmConfig;
  readOnly?: boolean;
};

export type IngestManyResult = {
  imported: number;
  skippedDuplicate: number;
  touchedSessions: string[];
};

export type IngestManyOptions = {
  readonly rebuildSummaries?: boolean;
};

export type SearchSessionArgs = {
  query?: string;
  limit?: number;
  cwd?: string;
  repoRoot?: string;
  excludeCurrentSession?: boolean;
  excludeSessionIds?: string[];
};

export type SearchOverflowArgs = {
  query: string;
  limit?: number;
  cwd?: string;
  repoRoot?: string;
};

export type ListSessionsArgs = {
  since?: string;
  until?: string;
  cwd?: string;
  repoRoot?: string;
  parentSessionId?: string;
  rootsOnly?: boolean;
  includeSummaries?: boolean;
  limit?: number;
  cursor?: string;
};

export type SessionPage = {
  sessions: SessionSummary[];
  next_cursor?: string;
};

export type UsageReport = {
  totals: {
    sessions: number;
    input_tokens: number;
    cached_input_tokens: number;
    output_tokens: number;
    reasoning_output_tokens: number;
    total_tokens: number;
  };
};

export type IndexCleanupReport = {
  applied: boolean;
  raw_log_preserved: true;
  index_path: string;
  database_bytes_before: number;
  database_bytes_after: number;
  event_fts_rows_before: number;
  event_fts_rows_after: number;
  projected_event_fts_rows: number;
  event_text_bytes_before: number;
  event_text_bytes_after: number;
  projected_summaries_to_rebuild: number;
  summaries_rebuilt: number;
  vacuumed: boolean;
};

export type SessionSummary = {
  session_id: string;
  first_seen: string;
  last_seen: string;
  cwd: string;
  repo_root?: string;
  git_branch?: string;
  event_count: number;
  parent_session_id?: string;
  agent_role?: string;
  agent_nickname?: string;
  model?: string;
  reasoning_effort?: string;
  total_input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
  match_count?: number;
  best_match?: SessionSearchMatch;
  discovery?: SessionDiscovery;
  summary?: SessionListSummary;
};

export type SessionListSummary = {
  updated_at: string;
  title: string;
  overview: string;
  topics: string[];
  key_prompts: string[];
  outcomes: string[];
  source_event_count: number;
};

export type SessionSearchMatch = {
  kind: "summary_node" | "session_summary" | "event";
  snippet: string;
  timestamp: string;
  score: number;
  node_id?: string;
  event_id?: string;
  depth?: number;
  topics?: string[];
  source_event_count?: number;
  source_token_count?: number;
};

export type SessionDiscovery = {
  confidence: "high" | "medium" | "low";
  score: number;
  reasons: string[];
};

export type SessionDetail = {
  session: SessionSummary | undefined;
  events: NormalizedEvent[];
  next_cursor?: string;
};

export type RecentContext = {
  session_id?: string;
  events: NormalizedEvent[];
};

export type ContextPlanState = "empty" | "under_limit" | "near_limit" | "over_limit" | "over_context";

export type ContextPlan = {
  session_id?: string;
  cwd?: string;
  repo_root?: string;
  model_context_window: number;
  auto_compact_token_limit: number;
  recent_event_limit: number;
  estimated_recent_tokens: number;
  estimated_summary_tokens: number;
  estimated_total_tokens: number;
  summary_node_count: number;
  latest_event_at: string | null;
  state: ContextPlanState;
  recommendation: string;
  suggested_tools: string[];
  can_control_compaction: false;
};

export type PackedContext = {
  markdown: string;
  estimated_tokens: number;
  sources: Array<{ kind: "event" | "note" | "checkpoint" | "summary"; session_id: string; event_id?: string; node_id?: string; timestamp: string }>;
};

export type PackContextArgs = {
  query?: string;
  sessionIds?: string[];
  currentThreadId?: string;
  budgetTokens?: number;
  cwd?: string;
};

export type QueryExpansionSource = {
  kind: "summary" | "event";
  session_id: string;
  timestamp: string;
  node_id?: string;
  event_id?: string;
  depth?: number;
  hook_event?: string;
};

export type LcmQueryExpansion = {
  query: string;
  markdown: string;
  estimated_tokens: number;
  truncated: boolean;
  nodes: SummaryNode[];
  events: NormalizedEvent[];
  sources: QueryExpansionSource[];
};

export type LcmDescription =
  | {
    target: "session";
    session: SessionSummary | undefined;
    summary: SessionMemorySummary | undefined;
    summary_nodes: SummaryNode[];
    file_refs: FileReference[];
  }
  | {
    target: "summary_node";
    node: SummaryNode;
    source_nodes: SummaryNode[];
    source_event_count: number;
  }
  | {
    target: "file_ref";
    file_ref: FileReference;
  }
  | {
    target: "overflow_ref";
    overflow_ref: OverflowContent;
  };

export type LcmExpansion = {
  target: "summary_node";
  node: SummaryNode;
  source_nodes: SummaryNode[];
  source_events: NormalizedEvent[];
  markdown: string;
};

export type GraphNode = {
  node_id: string;
  kind: "session" | "turn" | "event" | "checkpoint" | "summary";
  session_id: string;
  event_id?: string;
  turn_id?: string;
  timestamp: string;
  cwd: string;
  repo_root?: string;
  git_branch?: string;
  label: string;
  metadata: Record<string, unknown>;
};

export type GraphEdge = {
  from_node_id: string;
  to_node_id: string;
  kind: "contains" | "next" | "tool_result" | "checkpoint" | string;
  session_id: string;
  position: number;
  created_at: string;
  metadata: Record<string, unknown>;
};

export type SessionGraph = {
  session_id: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type Health = {
  home: string;
  raw_log_path: string;
  index_path: string;
  raw_log_exists: boolean;
  index_exists: boolean;
  index_available: boolean;
  index_error?: string;
  event_count: number;
  session_count: number;
  graph_node_count?: number;
  graph_edge_count?: number;
  summary_count?: number;
  session_summary_count?: number;
  summary_node_count?: number;
};

export type LcmStats = Health & {
  hook_event_counts: Record<string, number>;
  summary_nodes_by_depth: Record<string, number>;
  summary_nodes_by_source_type: Record<string, number>;
  graph_nodes_by_kind: Record<string, number>;
  graph_edges_by_kind: Record<string, number>;
  sessions_with_session_summary: number;
  sessions_with_summary_nodes: number;
  max_summary_depth: number | null;
  latest_event_at: string | null;
  latest_summary_node_at: string | null;
};
