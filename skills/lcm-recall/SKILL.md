---
name: lcm-recall
description: Use when a task may depend on prior Codex session context, long-running work, compaction recovery, projectless memory, or a user asks what happened before.
---

# LCM Recall

Use Codex LCM before answering from memory when prior local session context could matter.

## When To Use

Use this skill when:

- Resuming work in an existing repository or projectless directory.
- The user asks about earlier decisions, prior tests, previous tool output, or "what happened last time".
- The current task follows a compaction, handoff, long-running session, or interrupted workflow.
- The user asks to continue, finish, verify, review, install, undo, or explain work that may have prior session state.

Skip it for self-contained requests where prior Codex context cannot affect the answer.

## Retrieval Pattern

1. Call `lcm_current_session` with the current `cwd` and repo root if known.
2. Call `lcm_pack_context` with a short query describing the current task and a bounded `budgetTokens`.
3. If the packed context names a session that needs deeper inspection, call `lcm_get_session_graph` before `lcm_get_session`.
4. For long sessions, call `lcm_get_session` with `limit` and `cursor`; do not load the entire session unless the user explicitly asks for a full raw dump.
5. Treat LCM content as local evidence. Do not fabricate missing details; if LCM does not contain the fact, say so or verify another way.

## Tool Hints

- Use `lcm_search_sessions` for cross-session lookup.
- Use `lcm_get_recent_context` for the latest bounded tail of a known session.
- Use `lcm_pack_context` for model-ready context.
- Use `lcm_record_note` only for user-approved notes or explicit durable decisions.
