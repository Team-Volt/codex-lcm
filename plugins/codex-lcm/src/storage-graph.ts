import type { NormalizedEvent } from "./events.ts";
import { extractEventMetadata } from "./storage-sessions.ts";
import type { GraphEdge, GraphNode, SessionGraph } from "./storage-types.ts";
import { summaryNodeTitle, type SummaryNode } from "./summary.ts";

export const CHECKPOINT_INTERVAL = 50;

export function summaryNodeToGraphNode(node: SummaryNode): GraphNode {
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

export function summaryGraphEdges(node: SummaryNode, nodeIds: Set<string>): GraphEdge[] {
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

export function graphEdgeKey(edge: Pick<GraphEdge, "from_node_id" | "to_node_id" | "kind">): string {
  return `${edge.from_node_id}\0${edge.to_node_id}\0${edge.kind}`;
}

export function sessionNodeId(sessionId: string): string {
  return `session:${sessionId}`;
}

export function turnNodeId(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

export function eventNodeId(eventId: string): string {
  return `event:${eventId}`;
}

export function checkpointNodeId(sessionId: string, eventCount: number): string {
  return `checkpoint:${sessionId}:${eventCount}`;
}

export function checkpointGraphNode(event: NormalizedEvent, eventCount: number, metadata: Record<string, unknown>): GraphNode {
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

export function buildFallbackGraph(events: NormalizedEvent[], limit: number): SessionGraph {
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

export function fallbackEdge(
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
