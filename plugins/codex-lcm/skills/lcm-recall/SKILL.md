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

## Retrieval Rules

- Use the MCP tools. Do not inspect `~/.codex-lcm`, SQLite, or raw JSONL directly unless the user explicitly asks for storage forensics or MCP itself is broken.
- Use `lcm_stats` for aggregate storage, hook-event, summary-depth, graph-count, and freshness questions. It is the normal path for "how many summaries/nodes?" and "did PreCompact fire?" checks.
- Keep retrieval bounded. Prefer packed context, graph slices, limits, and cursors over full-session dumps.
- Treat `lcm_pack_context` as the model-ready retrieval path. It searches summary nodes first and expands bounded source lineage, so it is usually better than loading raw events for broad recall.
- For broad or meta questions, start with `lcm_search_sessions` and use each result's `best_match` clue before loading raw events. Summary titles, topics, outcomes, source event IDs, and best-match snippets are meant to be skimmed first.
- Treat `discovery.confidence` and `discovery.reasons` as the best first-pass signal for whether a session is worth opening. `best_match.score` is raw match strength, not a standalone relevance judgment.
- Broad search is tuned toward user-directed work sessions. Generated suggestion chatter remains available through raw session/event retrieval, but it should not be treated as durable evidence unless the user explicitly asks about suggestions.
- When the user asks about prior history and the current chat is likely to repeat the same terms, call `lcm_current_session` first and pass `excludeCurrentSession` or `excludeSessionIds` to `lcm_search_sessions`.
- `lcm_pack_context` may widen from cwd-scoped search to bounded global search if the scoped query has no matches. If the packed context is still thin, follow with `lcm_search_sessions` without `cwd`.
- Use `lcm_get_session_graph` to inspect summary nodes, checkpoints, and source lineage before loading raw event pages for long sessions.
- Treat LCM content as local evidence. Do not fabricate missing details; if LCM does not contain the fact, say so or verify another way.
- Do not silently write durable memories. Use `lcm_record_note` only when the user explicitly asks you to remember something or clearly approves saving a durable note.

## Retrieval Pattern

1. Identify the current `cwd` and repo root if available. Projectless sessions are valid; do not require git metadata.
2. Call `lcm_current_session` with the current `cwd` and repo root if known.
3. Call `lcm_pack_context` with a concrete query describing the current task and a bounded `budgetTokens`.
4. If the task may involve older work or another thread, call `lcm_search_sessions` with the same focused query.
5. For promising sessions, call `lcm_get_session_summary` before raw retrieval. Use the source event IDs and topics to decide whether deeper evidence is needed.
6. If a session needs deeper inspection, call `lcm_get_session_graph` before `lcm_get_session` to understand turns, checkpoints, and nearby events.
7. For long sessions, call `lcm_get_session` with `limit` and `cursor`; do not load the entire session unless the user explicitly asks for a full raw dump.
8. Use `lcm_get_recent_context` for the latest bounded tail of a known session.

## Tool Hints

- Use `lcm_current_session` first when the current Codex session may matter.
- Use `lcm_stats` when checking whether LCM is capturing hook events and building summaries, summary nodes, graph nodes, and graph edges as expected.
- Use `lcm_search_sessions` for cross-session lookup; inspect `discovery.confidence`, `discovery.reasons`, `best_match.kind`, `best_match.snippet`, and `best_match.topics` to decide which sessions deserve deeper retrieval.
- Use `lcm_get_session_summary` for compact semantic clues, outcomes, and source event IDs.
- Use `lcm_pack_context` for model-ready summary-node context with bounded source expansion.
- Use `lcm_get_session_graph` before raw event pagination for long or complex sessions; graph results include summary nodes and `summary_source` edges when available.
- Use `lcm_get_session` with `limit` and `cursor` when exact event detail is required.
- Use `lcm_get_recent_context` for the latest bounded tail of a known session.
- Use `lcm_record_note` only for user-approved notes or explicit durable decisions.
