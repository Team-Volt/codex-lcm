# Codex LCM Implementation Plan And Status

This plan has been implemented. The current native plugin manifest installs the
MCP server, lifecycle hooks, and `lcm-recall` skill through Codex plugin
installation. The `codex-lcm install` and `codex-lcm uninstall` commands remain
dry-run manual wiring planners, not the primary install path.

## Tasks

1. Create package and plugin skeleton:
   - `package.json`
   - `bin/codex-lcm`
   - `.codex-plugin/plugin.json`
   - `.mcp.json`
   - `hooks/hooks.codex.json`

2. Add test-first coverage:
   - Event normalization accepts known hook payload shapes and preserves unknown fields.
   - Redaction masks secret keys and obvious token strings.
   - Storage appends JSONL before indexing and can rebuild/search the SQLite index.
   - Hook ingestion handles malformed input, projectless sessions, and git metadata.
   - MCP tools list and call correctly over newline-delimited JSON-RPC.
   - Native plugin manifest declares MCP, hooks, and skill resources.
   - Manual installer dry-runs print planned MCP and hook changes without touching `~/.codex`.

3. Implement core modules:
   - `src/config.ts`: paths, limits, env handling.
   - `src/redact.ts`: recursive sanitizer and size guards.
   - `src/events.ts`: event schema and payload normalization.
   - `src/git.ts`: best-effort repo root/branch metadata.
   - `src/storage.ts`: JSONL append, SQLite schema, indexing, search, notes, context packing.
   - `src/mcp.ts`: stdio JSON-RPC server and MCP tool handlers.
   - `src/installer.ts`: status and dry-run manual install/uninstall planning.
   - `src/cli.ts`: command dispatch.

4. Add user docs:
   - `README.md`: install, commands, captured data, privacy controls, smoke test.
   - `docs/architecture.md`: event flow, storage layout, schema, and failure modes.
   - `docs/troubleshooting.md`: MCP, hooks, storage, and Codex Desktop/CLI checks.

5. Verify locally:
   - `npm test`
   - `node --no-warnings bin/codex-lcm install --dry-run`
   - synthetic hook ingestion with `CODEX_LCM_HOME` in `/private/tmp`
   - MCP initialize/list/call smoke test against `bin/codex-lcm mcp`
   - plugin manifest shape inspection and plugin validator if local dependencies allow it

## Acceptance Checklist

- Raw sanitized event is appended even if indexing fails.
- Projectless events are retrievable by session ID and latest cwd.
- Git repo root and branch are metadata only.
- Search crosses sessions and is not project-bound.
- Context packing respects a character/token budget.
- Native plugin install owns MCP, hooks, and skill wiring.
- Dry-run manual wiring planner does not modify `~/.codex`.
- README documents captured data and limitations clearly.
