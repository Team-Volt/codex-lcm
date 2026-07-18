---
name: lcm-recall
description: Use when a task may depend on prior Codex session context, long-running work, compaction recovery, projectless memory, or a user asks what happened before.
---

# LCM Recall

Use Codex LCM before answering from memory when prior local session context could
matter. LCM is local session evidence, not a replacement for reasoning or
verification.

## When To Use

Use this skill when:

- Resuming work in an existing repository or projectless directory.
- The user asks about earlier decisions, prior tests, previous tool output, or "what happened last time".
- The current task follows a compaction, handoff, long-running session, or interrupted workflow.
- The user asks to continue, finish, verify, review, install, undo, or explain work that may have prior session state.
- The task depends on prior Codex behavior in the same cwd, repo, thread, or projectless session.

Skip it for self-contained requests where prior Codex context cannot affect the answer.

After compaction or interrupted-workflow recovery, continue unfinished work unless
a concrete blocker remains. Do not stop merely because compaction happened or
because context had to be recovered.

## Retrieval Rules

- Use the MCP tools. Do not inspect `~/.codex-lcm`, SQLite, or raw JSONL directly unless the user explicitly asks for storage forensics or MCP itself is broken.
- Use `lcm_stats` for aggregate storage, hook-event, summary-depth, graph-count, and freshness questions. It is the normal path for "how many summaries/nodes?" and "did PreCompact/PostCompact fire?" checks.
- Use `lcm_context_plan` when deciding whether to pack LCM context before continuing a long or compacted session. It reports context pressure only; Codex owns compaction.
- Keep retrieval bounded. Prefer packed context, graph slices, limits, and cursors over full-session dumps.
- Keep Codex LCM MCP calls sequential. Do not fan out one call per session or run multiple LCM calls concurrently; each call opens an index reader and concurrent fan-out can multiply process and SQLite memory.
- For date-range or multi-session reviews, call `lcm_list_sessions` once with `includeSummaries: true`, then follow its cursor sequentially if needed. Only describe or expand the small set of sessions whose compact summaries need source evidence.
- The preferred standard workflow is `lcm_grep` -> `lcm_describe` -> `lcm_expand`: find candidates, inspect session or summary-node lineage, then expand a chosen summary node into bounded source evidence.
- In Codex, `mcp__codex_lcm__lcm_grep` -> `mcp__codex_lcm__lcm_describe` -> `mcp__codex_lcm__lcm_expand` are those same standard tools. Agents must use the host-qualified form Codex shows when the bare names are absent rather than fall back to lower-level session APIs.
- Use `lcm_expand_query` as the focused query-first alternative when you do not yet know which summary node to expand. It searches matching summary nodes and recursively expands source lineage into bounded evidence. It does not synthesize an answer. Use `overview: true` for broad lineage views, and remember `sourceLimit` is per matched node/source expansion.
- Treat `lcm_pack_context` as the model-ready retrieval path. It searches summary nodes first and expands bounded source lineage, so it is usually better than loading raw events for broad recall.
- For broad or meta questions, start with `lcm_grep` or `lcm_search_sessions` and use each result's `best_match` clue before loading raw events. Summary titles, topics, outcomes, source event IDs, and best-match snippets are meant to be skimmed first.
- Treat `discovery.confidence` and `discovery.reasons` as the best first-pass signal for whether a session is worth opening. `best_match.score` is raw match strength, not a standalone relevance judgment.
- Broad search is tuned toward user-directed work sessions. Generated suggestion chatter remains available through raw session/event retrieval, but it should not be treated as durable evidence unless the user explicitly asks about suggestions.
- When the user asks about prior history and the current chat is likely to repeat the same terms, call `lcm_current_session` first and pass `excludeCurrentSession` or `excludeSessionIds` to `lcm_grep` or `lcm_search_sessions`.
- `lcm_pack_context` may widen from cwd-scoped search to bounded global search if the scoped query has no matches. If the packed context is still thin, follow with `lcm_search_sessions` without `cwd`.
- Use `lcm_get_session_graph` to inspect summary nodes, checkpoints, and persisted source lineage before loading raw event pages for long sessions.
- If `lcm_describe` exposes `file_refs`, inspect relevant file references by `fileId` before opening raw event pages with large output payloads.
- Treat LCM content as local evidence. Do not fabricate missing details; if LCM does not contain the fact, say so or verify another way.
- Do not silently write durable memories. Use `lcm_record_note` only when the user explicitly asks you to remember something or clearly approves saving a durable note.

## Retrieval Pattern

1. Identify the current `cwd` and repo root if available. Projectless sessions are valid; do not require git metadata.
2. Call `lcm_current_session` with the current `cwd` and repo root if known.
3. Call `lcm_grep` with a concrete query and `cwd` or `repoRoot` when scope is known.
4. For a promising hit, call `lcm_describe` with the session ID. If it exposes a relevant summary node, call `lcm_expand` with that node ID.
5. Call `lcm_expand_query` when a focused query needs deeper source-lineage evidence and manual node selection would add friction.
6. Call `lcm_context_plan` when a long-running session may be near a soft context limit.
7. Call `lcm_pack_context` when you need a model-ready context block instead of manually reading descriptions and expansions.
8. If the task may involve older work or another thread, repeat `lcm_grep` or `lcm_search_sessions` with broader scope.
9. For long sessions, prefer `lcm_describe`, `lcm_get_session_graph`, and paged `lcm_get_session` with `limit` and `cursor`; do not load the entire session unless the user explicitly asks for a full raw dump.
10. Use `lcm_get_recent_context` for the latest bounded tail of a known session.

## Tool Hints

- Use `lcm_current_session` first when the current Codex session may matter.
- Use `lcm_stats` when checking whether LCM is capturing hook events and building summaries, summary nodes, graph nodes, and graph edges as expected.
- Use `lcm_grep` for normal discovery across summaries and high-signal events; inspect `discovery.confidence`, `discovery.reasons`, `best_match.kind`, `best_match.snippet`, and `best_match.topics` to decide which sessions deserve deeper retrieval.
- Use `lcm_describe` to inspect compact session summary nodes and source counts before expanding. Set `includeLineage: true` only when exact source ID arrays are required.
- Use `lcm_describe` with `fileId` to inspect large output references without loading full content.
- Use `lcm_expand` only after choosing a summary node. It expands bounded source summary nodes and source events, not an entire transcript.
- Use `lcm_expand_query` for focused recursive evidence expansion when the query itself should pick the matching summary nodes.
- Use `lcm_context_plan` for read-only context budget diagnostics and pack recommendations.
- Use `lcm_search_sessions` as the compatibility/advanced name for cross-session lookup.
- Use `lcm_get_session_summary` for compact semantic clues, outcomes, and source event IDs.
- Use `lcm_pack_context` for model-ready summary-node context with bounded source expansion.
- Use `lcm_get_session_graph` before raw event pagination for long or complex sessions; graph results include summary nodes and `summary_source` edges when available.
- Use `lcm_get_session` with `limit` and `cursor` when exact event detail is required.
- Use `lcm_get_recent_context` for the latest bounded tail of a known session.
- Use `lcm_record_note` only for user-approved notes or explicit durable decisions.
