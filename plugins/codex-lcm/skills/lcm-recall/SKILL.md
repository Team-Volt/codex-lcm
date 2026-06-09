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
- Keep retrieval bounded. Prefer packed context, graph slices, limits, and cursors over full-session dumps.
- Treat LCM content as local evidence. Do not fabricate missing details; if LCM does not contain the fact, say so or verify another way.
- Do not silently write durable memories. Use `lcm_record_note` only when the user explicitly asks you to remember something or clearly approves saving a durable note.

## Retrieval Pattern

1. Identify the current `cwd` and repo root if available. Projectless sessions are valid; do not require git metadata.
2. Call `lcm_current_session` with the current `cwd` and repo root if known.
3. Call `lcm_pack_context` with a concrete query describing the current task and a bounded `budgetTokens`.
4. If the task may involve older work or another thread, call `lcm_search_sessions` with the same focused query.
5. If a session needs deeper inspection, call `lcm_get_session_graph` before `lcm_get_session` to understand turns, checkpoints, and nearby events.
6. For long sessions, call `lcm_get_session` with `limit` and `cursor`; do not load the entire session unless the user explicitly asks for a full raw dump.
7. Use `lcm_get_recent_context` for the latest bounded tail of a known session.

## Tool Hints

- Use `lcm_current_session` first when the current Codex session may matter.
- Use `lcm_search_sessions` for cross-session lookup.
- Use `lcm_pack_context` for model-ready context.
- Use `lcm_get_session_graph` before raw event pagination for long or complex sessions.
- Use `lcm_get_session` with `limit` and `cursor` when exact event detail is required.
- Use `lcm_get_recent_context` for the latest bounded tail of a known session.
- Use `lcm_record_note` only for user-approved notes or explicit durable decisions.
