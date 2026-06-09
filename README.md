# Codex LCM Marketplace

This repository is a Codex plugin marketplace for Codex LCM.

Install from a local checkout with Codex's native plugin flow:

```sh
codex plugin marketplace add /path/to/codex-lcm
codex plugin add codex-lcm@codex-lcm
```

The native plugin manifest wires the MCP server, lifecycle hooks, and
`lcm-recall` skill. You do not need to run `codex-lcm install` after
`codex plugin add`; that command is only a dry-run manual wiring planner for
development or compatibility checks.

The plugin package lives in `plugins/codex-lcm/`. Run tests and development
commands from that directory.
