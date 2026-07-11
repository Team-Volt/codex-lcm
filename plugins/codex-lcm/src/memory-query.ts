import type { NormalizedEvent } from "./events.ts";
import type { DatabaseSync } from "node:sqlite";
import type { DurableMemory, MemoryRevision, MemorySourceContext, MemorySourceReference } from "./memory-domain.ts";

const DEFAULT_HISTORY_LIMIT = 20;
const MAX_HISTORY_LIMIT = 100;
const SOURCE_CONTEXT_EVENT_LIMIT = 20;

export function memoryApplies(memory: DurableMemory, cwd: string | undefined, repoRoot: string | undefined, scopeKinds: DurableMemory["scope"]["kind"][] | undefined): boolean {
  if (scopeKinds && !scopeKinds.includes(memory.scope.kind)) return false;
  if (memory.scope.kind === "global") return true;
  return memory.scope.kind === "repo" ? repoRoot === memory.scope.key : cwd === memory.scope.key;
}
export function memoryScopeRank(memory: DurableMemory, cwd: string | undefined, repoRoot: string | undefined): number {
  if (memory.scope.kind === "global") return 1;
  if (memory.scope.kind === "repo") return memory.scope.key === repoRoot ? 2 : 0;
  return memory.scope.key === cwd ? 2 : 0;
}

export function memorySearchScore(memory: DurableMemory, query: string): number {
  if (query.length === 0) return 0;
  const haystack = `${memory.text}\n${memory.tags.join(" ")}\n${memory.kind}`.toLocaleLowerCase();
  return query.split(/\s+/u).filter(Boolean).reduce((score, term) => score + Number(haystack.includes(term)), 0);
}

export function memoryHistoryLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_HISTORY_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_HISTORY_LIMIT) {
    throw new Error(`historyLimit must be an integer from 1 to ${MAX_HISTORY_LIMIT}.`);
  }
  return value;
}

export function memoryHistoryEnd(cursor: string | undefined, total: number): number {
  if (cursor === undefined) return total;
  const end = cursorNumber(cursor);
  if (end > total) throw new Error("historyCursor is outside the available history.");
  return end;
}

export function memoryHistoryOffset(cursor: string | undefined): number {
  return cursor === undefined ? 0 : cursorNumber(cursor);
}

export function memorySourceContext(revisions: readonly MemoryRevision[], events: readonly NormalizedEvent[], before = 2, after = 2): MemorySourceContext {
  const windowBefore = Math.min(Math.max(before, 0), 9);
  const windowAfter = Math.min(Math.max(after, 0), 10);
  const sessions = new Map<string, { events: NormalizedEvent[]; positions: Map<string, number> }>();
  const eventsById = new Map<string, NormalizedEvent>();
  for (const event of events) {
    eventsById.set(event.event_id, event);
    const session = sessions.get(event.session_id) ?? { events: [], positions: new Map<string, number>() };
    session.positions.set(event.event_id, session.events.length);
    session.events.push(event);
    sessions.set(event.session_id, session);
  }
  const selected = new Set<string>();
  const sources: MemorySourceReference[] = [];
  for (const revision of revisions) {
    for (const sourceEventId of revision.source_event_ids) {
      const sourceEvent = eventsById.get(sourceEventId);
      const session = sourceEvent ? sessions.get(sourceEvent.session_id) : undefined;
      const index = session?.positions.get(sourceEventId);
      if (index === undefined || !session) continue;
      const start = Math.max(0, index - windowBefore);
      const end = Math.min(session.events.length, index + windowAfter + 1, start + SOURCE_CONTEXT_EVENT_LIMIT);
      const eventIds = session.events.slice(start, end).map((event) => event.event_id);
      for (const eventId of eventIds) selected.add(eventId);
      sources.push({
        revision_event_id: revision.revision_event_id,
        source_event_id: sourceEventId,
        event_ids: eventIds,
      });
    }
  }
  return { events: events.filter((event) => selected.has(event.event_id)), sources };
}

export function indexedMemorySourceContext(db: DatabaseSync, revisions: readonly MemoryRevision[], before = 2, after = 2): MemorySourceContext {
  const windowBefore = Math.min(Math.max(before, 0), 9);
  const windowAfter = Math.min(Math.max(after, 0), 10);
  const selected = new Map<string, { readonly event: NormalizedEvent; readonly rowid: number }>();
  const sources: MemorySourceReference[] = [];
  const sourceQuery = db.prepare("SELECT rowid, session_id, timestamp FROM events WHERE event_id = ?1");
  const precedingQuery = db.prepare(`
    SELECT rowid, raw_json FROM events
    WHERE session_id = ?1 AND (timestamp < ?2 OR (timestamp = ?2 AND rowid <= ?3))
    ORDER BY timestamp DESC, rowid DESC LIMIT ?4
  `);
  const followingQuery = db.prepare(`
    SELECT rowid, raw_json FROM events
    WHERE session_id = ?1 AND (timestamp > ?2 OR (timestamp = ?2 AND rowid > ?3))
    ORDER BY timestamp ASC, rowid ASC LIMIT ?4
  `);
  for (const revision of revisions) {
    for (const sourceEventId of revision.source_event_ids) {
      const source = sourceQuery.get(sourceEventId) as { readonly rowid: number; readonly session_id: string; readonly timestamp: string } | undefined;
      if (!source) continue;
      const rows = [
        ...(precedingQuery.all(source.session_id, source.timestamp, source.rowid, windowBefore + 1) as Array<{ readonly rowid: number; readonly raw_json: string }>).reverse(),
        ...followingQuery.all(source.session_id, source.timestamp, source.rowid, windowAfter) as Array<{ readonly rowid: number; readonly raw_json: string }>,
      ];
      const eventIds: string[] = [];
      for (const row of rows) {
        const event = JSON.parse(row.raw_json) as NormalizedEvent;
        eventIds.push(event.event_id);
        selected.set(event.event_id, { event, rowid: row.rowid });
      }
      sources.push({ revision_event_id: revision.revision_event_id, source_event_id: sourceEventId, event_ids: eventIds });
    }
  }
  return { events: [...selected.values()].sort((left, right) => left.rowid - right.rowid).map(({ event }) => event), sources };
}

function cursorNumber(cursor: string): number {
  if (!/^[1-9][0-9]*$/u.test(cursor)) throw new Error("historyCursor must be a positive integer string.");
  const value = Number(cursor);
  if (!Number.isSafeInteger(value)) throw new Error("historyCursor is outside the available history.");
  return value;
}
