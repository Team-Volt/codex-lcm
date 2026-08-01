import type { DatabaseSync } from "node:sqlite";

import { decodePersistedEvent } from "./event-codec.ts";
import type { NormalizedEvent } from "./events.ts";
import { readRawEvents } from "./raw-log.ts";
import { recordValue } from "./storage-rows.ts";
import { countMap, extractEventMetadata } from "./storage-sessions.ts";
import { getSummaryNodesForGraph } from "./storage-summaries.ts";
import type { GraphEdge, GraphNode, SessionGraph } from "./storage-types.ts";
import { summaryNodeTitle, type SummaryNode } from "./summary.ts";

export const CHECKPOINT_INTERVAL = 50;

function summaryNodeToGraphNode(node: SummaryNode): GraphNode {
  return {
    node_id: node.node_id,
    kind: "summary",
    session_id: node.session_id,
    timestamp: node.latest_at,
    cwd: node.cwd,
    repo_root: node.repo_root,
    git_branch: node.git_branch,
    label: `D${node.depth} ${summaryNodeTitle(node)}`,
    metadata: {
      depth: node.depth,
      source_type: node.source_type,
      source_ids: node.source_ids,
      source_event_ids: node.source_event_ids,
      token_count: node.token_count,
      source_token_count: node.source_token_count,
      topics: node.topics,
      earliest_at: node.earliest_at,
      latest_at: node.latest_at,
    },
  };
}

function summaryGraphEdges(node: SummaryNode, nodeIds: Set<string>): GraphEdge[] {
  return node.source_ids.flatMap((sourceId, index) => {
    const targetId = node.source_type === "events" ? eventNodeId(sourceId) : sourceId;
    if (!nodeIds.has(node.node_id) || !nodeIds.has(targetId)) return [];
    return [{
      from_node_id: node.node_id,
      to_node_id: targetId,
      kind: "summary_source",
      session_id: node.session_id,
      position: index,
      created_at: node.created_at,
      metadata: {
        depth: node.depth,
        source_type: node.source_type,
      },
    }];
  });
}

function graphEdgeKey(edge: Pick<GraphEdge, "from_node_id" | "to_node_id" | "kind">): string {
  return `${edge.from_node_id}\0${edge.to_node_id}\0${edge.kind}`;
}

function sessionNodeId(sessionId: string): string {
  return `session:${sessionId}`;
}

function turnNodeId(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

function eventNodeId(eventId: string): string {
  return `event:${eventId}`;
}

function checkpointNodeId(sessionId: string, eventCount: number): string {
  return `checkpoint:${sessionId}:${eventCount}`;
}

function checkpointGraphNode(event: NormalizedEvent, eventCount: number, metadata: Record<string, unknown>): GraphNode {
  return {
    node_id: checkpointNodeId(event.session_id, eventCount),
    kind: "checkpoint",
    session_id: event.session_id,
    timestamp: event.timestamp,
    cwd: event.cwd,
    repo_root: event.repo_root,
    git_branch: event.git_branch,
    label: `Checkpoint after ${eventCount} events`,
    metadata,
  };
}

function buildFallbackGraph(events: NormalizedEvent[], limit: number): SessionGraph {
  const sessionId = events[0]?.session_id ?? "";
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const seen = new Set<string>();
  const edgeKeys = new Set<string>();
  const preToolEvents = new Map<string, NormalizedEvent>();
  const addNode = (node: GraphNode) => {
    if (seen.has(node.node_id) || nodes.length >= limit) return;
    seen.add(node.node_id);
    nodes.push(node);
  };
  const addEdge = (edge: GraphEdge) => {
    const key = graphEdgeKey(edge);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push(edge);
  };

  for (const [index, event] of events.entries()) {
    const metadata = extractEventMetadata(event);
    const sessionNode = sessionNodeId(event.session_id);
    addNode({
      node_id: sessionNode,
      kind: "session",
      session_id: event.session_id,
      timestamp: event.timestamp,
      cwd: event.cwd,
      repo_root: event.repo_root,
      git_branch: event.git_branch,
      label: `Session ${event.session_id}`,
      metadata: { fallback: true },
    });
    const parentNode = metadata.turn_id ? turnNodeId(event.session_id, metadata.turn_id) : sessionNode;
    if (metadata.turn_id) {
      addNode({
        node_id: parentNode,
        kind: "turn",
        session_id: event.session_id,
        turn_id: metadata.turn_id,
        timestamp: event.timestamp,
        cwd: event.cwd,
        repo_root: event.repo_root,
        git_branch: event.git_branch,
        label: `Turn ${metadata.turn_id}`,
        metadata: { fallback: true, turn_id: metadata.turn_id },
      });
      addEdge(fallbackEdge(sessionNode, parentNode, "contains", event.session_id, index, event.timestamp));
    }
    const eventNode = eventNodeId(event.event_id);
    addNode({
      node_id: eventNode,
      kind: "event",
      session_id: event.session_id,
      event_id: event.event_id,
      turn_id: metadata.turn_id,
      timestamp: event.timestamp,
      cwd: event.cwd,
      repo_root: event.repo_root,
      git_branch: event.git_branch,
      label: `${event.hook_event} ${event.timestamp}`,
      metadata: {
        fallback: true,
        hook_event: event.hook_event,
        tool_name: event.tool_name,
        turn_id: metadata.turn_id,
        tool_use_id: metadata.tool_use_id,
      },
    });
    addEdge(fallbackEdge(parentNode, eventNode, "contains", event.session_id, index, event.timestamp));
    if (index > 0) {
      addEdge(fallbackEdge(eventNodeId(events[index - 1].event_id), eventNode, "next", event.session_id, index, event.timestamp));
    }
    if (event.hook_event === "PreToolUse" && metadata.tool_use_id) {
      preToolEvents.set(metadata.tool_use_id, event);
    } else if (event.hook_event === "PostToolUse" && metadata.tool_use_id) {
      const preTool = preToolEvents.get(metadata.tool_use_id);
      if (preTool) addEdge(fallbackEdge(eventNodeId(preTool.event_id), eventNode, "tool_result", event.session_id, index, event.timestamp));
    }
    const eventCount = index + 1;
    if (event.hook_event === "PreCompact" || eventCount % CHECKPOINT_INTERVAL === 0) {
      const checkpoint = checkpointGraphNode(event, eventCount, { fallback: true, event_count: eventCount });
      addNode(checkpoint);
      addEdge(fallbackEdge(sessionNode, checkpoint.node_id, "checkpoint", event.session_id, eventCount, event.timestamp));
    }
  }

  const nodeIds = new Set(nodes.map((node) => node.node_id));
  return {
    session_id: sessionId,
    nodes,
    edges: edges.filter((edge) => nodeIds.has(edge.from_node_id) && nodeIds.has(edge.to_node_id)),
  };
}

function fallbackEdge(
  fromNodeId: string,
  toNodeId: string,
  kind: string,
  sessionId: string,
  position: number,
  createdAt: string,
): GraphEdge {
  return {
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    kind,
    session_id: sessionId,
    position,
    created_at: createdAt,
    metadata: { fallback: true },
  };
}

export function getStoredSessionGraph(
  db: DatabaseSync | undefined,
  rawLogPath: string,
  sessionId: string,
  limit: number,
): SessionGraph {
  if (!db) return buildFallbackGraph(readRawEvents(rawLogPath).filter((event) => event.session_id === sessionId), limit);

  const summaryBudget = limit >= 20
    ? Math.min(Math.max(Math.ceil(limit * 0.25), 8), Math.floor(limit / 2))
    : Math.max(0, Math.floor(limit / 4));
  const graphNodeLimit = Math.max(1, limit - summaryBudget);
  const events = db.prepare(`
    SELECT raw_json FROM events
    WHERE session_id = ?1
    ORDER BY timestamp ASC, rowid ASC
    LIMIT ?2
  `).all(sessionId, graphNodeLimit)
    .map((row) => decodePersistedEvent(String(recordValue(row).raw_json)));
  const graph = buildFallbackGraph(events, graphNodeLimit);
  const nodes = graph.nodes.map((node) => {
    if (node.kind !== "checkpoint") return node;
    const eventCount = Number(node.metadata.event_count ?? 0);
    return { ...node, metadata: buildCheckpointMetadata(db, sessionId, eventCount) };
  });
  const remainingNodeBudget = Math.max(0, limit - nodes.length);
  const rawSummaryNodes = remainingNodeBudget > 0
    ? getSummaryNodesForGraph(db, sessionId, remainingNodeBudget)
    : [];
  const summaryNodes = rawSummaryNodes.map(summaryNodeToGraphNode);
  nodes.push(...summaryNodes);
  const nodeIds = new Set(nodes.map((node) => node.node_id));
  const edges = graph.edges;
  const edgeKeys = new Set(edges.map((edge) => graphEdgeKey(edge)));
  for (const edge of rawSummaryNodes.flatMap((node) => summaryGraphEdges(node, nodeIds))) {
    const key = graphEdgeKey(edge);
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push(edge);
  }
  return { session_id: sessionId, nodes, edges };
}

export function getLatestCheckpoint(db: DatabaseSync | undefined, sessionId: string): GraphNode | undefined {
  if (!db) return undefined;
  const row = recordValue(db.prepare(`
    SELECT raw_json, position FROM (
      SELECT raw_json, hook_event,
        ROW_NUMBER() OVER (ORDER BY timestamp, rowid) AS position
      FROM events
      WHERE session_id = ?1
    )
    WHERE hook_event = 'PreCompact' OR position % ${CHECKPOINT_INTERVAL} = 0
    ORDER BY position DESC
    LIMIT 1
  `).get(sessionId));
  if (typeof row.raw_json !== "string") return undefined;
  const event = decodePersistedEvent(row.raw_json);
  const position = Number(row.position);
  return checkpointGraphNode(event, position, buildCheckpointMetadata(db, sessionId, position));
}

function buildCheckpointMetadata(
  db: DatabaseSync | undefined,
  sessionId: string,
  eventCount: number,
): Record<string, unknown> {
  if (!db) return { event_count: eventCount };
  const counts = db.prepare(`
    WITH ordered AS (
      SELECT hook_event, ROW_NUMBER() OVER (ORDER BY timestamp, rowid) AS position
      FROM events
      WHERE session_id = ?1
    )
    SELECT hook_event, COUNT(*) AS count
    FROM ordered
    WHERE position <= ?2
    GROUP BY hook_event
    ORDER BY hook_event ASC
  `).all(sessionId, eventCount).map((row) => {
    const record = recordValue(row);
    return { hook_event: String(record.hook_event), count: Number(record.count) };
  });
  const recent = db.prepare(`
    WITH ordered AS (
      SELECT event_id, timestamp, hook_event,
        ROW_NUMBER() OVER (ORDER BY timestamp, rowid) AS position
      FROM events
      WHERE session_id = ?1
    )
    SELECT event_id, timestamp, hook_event
    FROM ordered
    WHERE position <= ?2
    ORDER BY position DESC
    LIMIT 5
  `).all(sessionId, eventCount).map((row) => {
    const record = recordValue(row);
    return {
      event_id: String(record.event_id),
      timestamp: String(record.timestamp),
      hook_event: String(record.hook_event),
    };
  });
  return { event_count: eventCount, hook_event_counts: counts, recent_events: recent };
}

export function derivedGraphNodeCounts(db: DatabaseSync | undefined): Record<string, number> {
  return countMap(db, `
    WITH ordered_events AS (
      SELECT hook_event,
        ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp, rowid) AS position
      FROM events
    ), counts AS (
      SELECT 'session' AS key, COUNT(*) AS count FROM sessions
      UNION ALL
      SELECT 'turn', COUNT(*) FROM (
        SELECT 1 FROM events WHERE turn_id IS NOT NULL GROUP BY session_id, turn_id
      )
      UNION ALL
      SELECT 'event', COUNT(*) FROM events
      UNION ALL
      SELECT 'checkpoint', COUNT(*) FROM ordered_events
      WHERE hook_event = 'PreCompact' OR position % ${CHECKPOINT_INTERVAL} = 0
      UNION ALL
      SELECT 'summary', COUNT(*) FROM summary_nodes
    )
    SELECT key, count FROM counts WHERE count > 0 ORDER BY key
  `);
}

export function derivedGraphEdgeCounts(db: DatabaseSync | undefined): Record<string, number> {
  return countMap(db, `
    WITH ordered_events AS (
      SELECT rowid AS event_rowid, session_id, hook_event, tool_use_id, timestamp,
        ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY timestamp, rowid) AS position
      FROM events
    ), counts AS (
      SELECT 'contains' AS key,
        (SELECT COUNT(*) FROM events) +
        (SELECT COUNT(*) FROM (
          SELECT 1 FROM events WHERE turn_id IS NOT NULL GROUP BY session_id, turn_id
        )) AS count
      UNION ALL
      SELECT 'next', COALESCE(SUM(MAX(event_count - 1, 0)), 0) FROM sessions
      UNION ALL
      SELECT 'tool_result', COUNT(*) FROM ordered_events post
      WHERE post.hook_event = 'PostToolUse' AND post.tool_use_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM events pre
          WHERE pre.session_id = post.session_id
            AND pre.hook_event = 'PreToolUse'
            AND pre.tool_use_id = post.tool_use_id
            AND (pre.timestamp < post.timestamp OR (pre.timestamp = post.timestamp AND pre.rowid < post.event_rowid))
        )
      UNION ALL
      SELECT 'checkpoint', COUNT(*) FROM ordered_events
      WHERE hook_event = 'PreCompact' OR position % ${CHECKPOINT_INTERVAL} = 0
      UNION ALL
      SELECT 'summary_source', COALESCE(SUM(json_array_length(source_ids_json)), 0) FROM summary_nodes
    )
    SELECT key, count FROM counts WHERE count > 0 ORDER BY key
  `);
}
