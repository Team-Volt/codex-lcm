import { parseMemoryPayload, type MemoryPayload, type NormalizedEvent } from "./events.ts";
import {
  memoryFromPayload,
  memoryInheritsCurrentState,
  memoryPayloadStatusMismatch,
  memoryScopeMatchesEvent,
  memorySourcesInSession,
  memoryTransitionCategory,
  type DurableMemory,
  type MemoryRevision,
} from "./memory-domain.ts";

export type MemoryAcceptance =
  | { readonly accepted: true; readonly memory: DurableMemory; readonly payload: MemoryPayload }
  | {
    readonly accepted: false;
    readonly category: string;
    readonly reason: "payload" | "lineage" | "scope" | "transition";
    readonly current?: DurableMemory;
    readonly payload?: MemoryPayload;
  };

export type MemoryReplay = {
  readonly memories: Map<string, DurableMemory>;
  readonly invalidMemoryEvents: Map<string, number>;
};

export type MemoryReplaySources = {
  readonly currentMemory: (memoryId: string) => DurableMemory | undefined;
  readonly sourceEvent: (eventId: string) => NormalizedEvent | undefined;
};

export function acceptMemoryEvent(
  event: NormalizedEvent,
  sources: MemoryReplaySources,
): MemoryAcceptance {
  const payload = parseMemoryPayload(event.payload);
  if (!payload) {
    return {
      accepted: false,
      category: memoryPayloadStatusMismatch(event.payload) ? "invalid_operation_status" : "invalid_payload",
      reason: "payload",
    };
  }
  const current = sources.currentMemory(payload.memory_id);
  const inheritsSources = current !== undefined
    && payload.source_event_ids.length === current.source_event_ids.length
    && payload.source_event_ids.every((sourceEventId, index) => sourceEventId === current.source_event_ids[index]);
  const sourceEvents = memorySourcesInSession(inheritsSources ? current.session_id : event.session_id, payload.source_event_ids, sources.sourceEvent);
  if (!sourceEvents) return { accepted: false, category: "invalid_payload", reason: "lineage", payload };
  if (!memoryScopeMatchesEvent(event, payload.scope, sourceEvents)) {
    return { accepted: false, category: "invalid_payload", reason: "scope", payload };
  }
  const category = memoryTransitionCategory(payload, current);
  if (category) return { accepted: false, category, reason: "transition", payload, current };
  if (current && !memoryInheritsCurrentState(payload, current)) {
    return { accepted: false, category: "invalid_payload", reason: "payload", payload, current };
  }
  return {
    accepted: true,
    memory: memoryFromPayload(event, payload, current),
    payload,
  };
}

export function foldMemoryEvents(events: readonly NormalizedEvent[]): Map<string, DurableMemory> {
  return replayMemoryEvents(events).memories;
}

export function replayMemoryEvents(events: readonly NormalizedEvent[]): MemoryReplay {
  const memories = new Map<string, DurableMemory>();
  const sources = new Map<string, NormalizedEvent>();
  const invalidMemoryEvents = new Map<string, number>();
  for (const event of events) {
    if (event.hook_event === "Memory") {
      const accepted = acceptMemoryEvent(event, {
        currentMemory: (memoryId) => memories.get(memoryId),
        sourceEvent: (eventId) => sources.get(eventId),
      });
      if (accepted.accepted) memories.set(accepted.memory.memory_id, accepted.memory);
      else invalidMemoryEvents.set(accepted.category, (invalidMemoryEvents.get(accepted.category) ?? 0) + 1);
    }
    sources.set(event.event_id, event);
  }
  return { memories, invalidMemoryEvents };
}

export function memoryRevisions(events: readonly NormalizedEvent[], memoryId: string): MemoryRevision[] {
  const memories = new Map<string, DurableMemory>();
  const revisions: MemoryRevision[] = [];
  const sources = new Map<string, NormalizedEvent>();
  for (const event of events) {
    if (event.hook_event === "Memory") {
      const accepted = acceptMemoryEvent(event, {
        currentMemory: (currentMemoryId) => memories.get(currentMemoryId),
        sourceEvent: (eventId) => sources.get(eventId),
      });
      if (accepted.accepted) {
        memories.set(accepted.memory.memory_id, accepted.memory);
        if (accepted.payload.memory_id === memoryId) {
          revisions.push({
            ...accepted.memory,
            operation: accepted.payload.operation,
            ...(accepted.payload.reason ? { reason: accepted.payload.reason } : {}),
          });
        }
      }
    }
    sources.set(event.event_id, event);
  }
  return revisions.sort((left, right) => left.revision - right.revision || left.updated_at.localeCompare(right.updated_at) || left.revision_event_id.localeCompare(right.revision_event_id));
}

export function memoryRevisionFromAcceptedMemoryEvent(event: NormalizedEvent, current: DurableMemory): MemoryRevision | undefined {
  const payload = parseMemoryPayload(event.payload);
  if (!payload) return undefined;
  return {
    ...memoryFromPayload(event, payload, current),
    operation: payload.operation,
    ...(payload.reason ? { reason: payload.reason } : {}),
  };
}
