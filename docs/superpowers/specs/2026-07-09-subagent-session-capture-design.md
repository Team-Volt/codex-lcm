# Subagent session capture

## Problem

Codex writes each spawned agent to its own rollout file, but ordinary session
hooks do not run inside that agent. LCM therefore records the parent session
and misses the child session.

Codex exposes a `SubagentStop` hook with `agent_transcript_path`. That path is
the stable handoff point for capture.

## Design

Register `SubagentStop` in the plugin hook manifest. When it fires, keep the
normal lifecycle event and import the file named by `agent_transcript_path`
into the same LCM store.

Spawned rollout files contain inherited parent history before the child's own
`session_meta` record. The importer must scope each rollout to the UUID in its
filename and ignore records belonging to inherited sessions. This prevents
duplicate parent events while preserving the complete child transcript.

If the transcript path is absent, the hook still records the lifecycle event.
If transcript import fails, report the error on stderr without discarding the
hook event.

## Test

Add one end-to-end hook test with a forked rollout fixture:

- parent history appears before the child `session_meta`;
- `SubagentStop` imports the child prompt and response;
- no inherited parent transcript events are imported;
- the hook manifest registers `SubagentStop`.

Run the full plugin test and typecheck commands after the focused test passes.
