# PROJECT KNOWLEDGE BASE

Generated: 2026-08-01
Commit: c9f395d
Branch: fix/review-findings

## OVERVIEW

Codex LCM is a local-first Codex plugin that captures sanitized lifecycle events,
stores raw JSONL before indexing, and exposes source-backed recall through MCP.
The repository root is the marketplace, CI, release-documentation, and package
wrapper; the TypeScript product lives under `plugins/codex-lcm`.

## STRUCTURE

```text
./
├── .agents/plugins/marketplace.json  # Local marketplace registration
├── .github/workflows/ci.yml          # Package quality gate
├── docs/releases/                    # Tagged release notes and checklists
└── plugins/codex-lcm/                # Publishable native Codex plugin
    ├── .codex-plugin/                # Plugin manifest
    ├── hooks/                         # Lifecycle hook registration
    ├── skills/                        # Bundled recall skill
    ├── src/                           # TypeScript implementation
    └── tests/                         # Node test suite
```

Generated work under `.omo/` and `.superpowers/` is task evidence, not product
source. Do not infer project architecture or contribution rules from it.

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| Plugin behavior | `plugins/codex-lcm/src/` | See the local `AGENTS.md` for storage invariants |
| Public commands and scripts | `plugins/codex-lcm/package.json` | The root has no package manifest |
| Install wiring | `plugins/codex-lcm/.codex-plugin/plugin.json` | Points to MCP, hooks, and skills |
| MCP registration | `plugins/codex-lcm/.mcp.json` | Starts `node ./bin/codex-lcm mcp` |
| Hook registration | `plugins/codex-lcm/hooks/hooks.codex.json` | Validated by the manifest test |
| Architecture | `plugins/codex-lcm/docs/architecture.md` | Detailed storage and retrieval design |
| Tests | `plugins/codex-lcm/tests/` | See the local test guidance |
| CI | `.github/workflows/ci.yml` | Runs from the plugin package directory |
| Release state | `README.md`, `docs/releases/` | Keep version, tag, and release docs aligned |

## CODE MAP

| Symbol | Location | Role |
|---|---|---|
| `LcmStorage` | `plugins/codex-lcm/src/storage.ts` | Public storage facade |
| `createStorage` | `plugins/codex-lcm/src/storage.ts` | Main construction path and repository-wide hub |
| `main` | `plugins/codex-lcm/src/cli.ts` | CLI dispatcher called by the bin wrapper |
| `startMcpServer` | `plugins/codex-lcm/src/mcp.ts` | JSON-RPC stdio server |
| `callTool` | `plugins/codex-lcm/src/mcp-tools.ts` | MCP tool dispatch |
| `runHook` | `plugins/codex-lcm/src/hook.ts` | Lifecycle-event ingestion |

Centrality was checked with TypeScript language-server references. No codegraph
service is available in this workspace; `createStorage` is the dominant shared
entry point, while the CLI and hook symbols are narrow boundaries.

## CONVENTIONS

- Run Node and npm commands from `plugins/codex-lcm`; root-level npm commands
  target no package.
- Keep the plugin dependency-light. It currently has no runtime npm dependencies.
- Treat `.codex-plugin/plugin.json`, `.mcp.json`, and the hook manifest as one
  install surface, and update their contract test when wiring changes.
- Keep root documentation focused on installation, releases, and repository
  navigation. Put implementation rules in the nearest child `AGENTS.md`.
- Use Node 22.18 or newer locally. CI pins Node 22.22.3.

## ANTI-PATTERNS

- Do not edit `.omo/` evidence as if it were product code.
- Do not copy the full hook or MCP tool lists into contributor guidance; the
  manifests, package README, and tests are the source of truth.
- Do not release with a mismatch among `package.json`, the Git tag, root README,
  and `docs/releases/`.
- Do not add a root build system for the single nested package.

## COMMANDS

```sh
cd plugins/codex-lcm
npm run typecheck
npm test
npm run smoke
npm pack --dry-run
```

For focused runtime checks, use `node bin/codex-lcm --help`, `doctor --json`,
`health --json`, or `stats --json` from the package directory. Use a temporary
`CODEX_LCM_HOME` for tests and experiments; never point destructive checks at a
user's live store.

## NOTES

- `events.jsonl` is authoritative; SQLite, FTS, summaries, and graph views are
  derived and rebuildable.
- Native plugin refreshes may require removing and re-adding the marketplace,
  then restarting Codex so the cache, MCP server, hooks, and skill reload.
- Release procedures live in `docs/releases/`; do not encode a second checklist
  here.
