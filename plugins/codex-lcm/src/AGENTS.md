# Source Contributor Guide

## Ownership map

- `storage.ts` is the public storage facade and the ingestion/reconciliation boundary.
- `raw-log.ts` owns append-only JSONL I/O and the cross-process raw-log lock.
- `storage-persistence.ts` owns SQLite schema maintenance, derived-index writes, and rebuild helpers.
- `storage-context.ts`, `storage-search.ts`, `storage-sessions.ts`, and `storage-summaries.ts` own read/query and deterministic derived views.
- `storage-graph.ts` derives bounded graph slices from indexed events and summary lineage; it does not persist a graph projection.
- `overflow.ts` owns bounded, content-addressed overflow storage and recovery checks.

## Storage invariants

- Sanitize and normalize input before any disk write. Append the sanitized event to `events.jsonl` under `withRawLogLock` before SQLite work.
- `events.jsonl` is the authoritative append-only record. SQLite, FTS, session summaries, summary nodes, file references, and graph slices are derived and rebuildable.
- An indexing failure may surface as an index error, but must never discard an event that is already durable in the raw log. Retries must not duplicate raw event IDs.
- Hold the raw-log lock only for the smallest snapshot, duplicate check, or append. Do not perform SQLite indexing, summaries, or graph work while it is held.
- Treat malformed raw JSONL as evidence loss: permit non-destructive reads and appends, but block destructive index reconciliation until repair.
- Writable open may replay or reconcile derived state from raw JSONL. `readOnly: true` must neither create storage nor rebuild, backfill, compact, or mutate derived state.

## Derived views

- Summaries are deterministic and extractive from sanitized source events. Keep stable ordering, bounded long-session sampling, and exact source event IDs.
- Build graphs on demand from indexed event order and summary lineage. Keep slices bounded and never add a stored node/edge projection.
- Read-only diagnostics and retrieval must fall back to raw JSONL when SQLite is absent or fails, without attempting repair.

## Overflow and safety

- Keep oversized content confined to managed overflow storage. References are content-addressed with SHA-256 and recovery accepts only verified regular files inside that directory.
- Preserve byte limits, paging limits, and integrity checks. References rejected before a file read consume no scan bytes; every file actually read, including a hash-invalid payload, counts against the scan budget.
- Keep permissions restrictive for the home, raw log, lock coordinator, SQLite index, and overflow files.

## Source anti-patterns

- Do not make SQLite the source of truth, repair an index by deleting raw events, or add a parallel persisted graph.
- Do not silently skip malformed lines during destructive reconciliation.
- Do not let a derived-index transaction cover raw appends, or keep the raw-log lock during expensive work.
- Do not turn a read path into an implicit migration or backfill.

## Test routing

- Storage, raw durability, reconciliation, locks, read-only behavior, cleanup, and overflow: `tests/storage.test.ts`.
- Public storage exports and raw-only scoped reads: `tests/storage-api.test.ts`.
- Deterministic summary selection and ranking: `tests/summary.test.ts`.
- On-demand graph, lineage, bounded packing, and migrations: `tests/dag.test.ts`.
