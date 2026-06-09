import { spawnSync } from "node:child_process";

import type { RepoMetadata } from "./events.ts";

export function resolveGitMetadata(cwd: string): RepoMetadata {
  const repoRoot = runGit(["rev-parse", "--show-toplevel"], cwd);
  if (!repoRoot) return {};
  return {
    repoRoot,
    gitBranch: runGit(["branch", "--show-current"], repoRoot),
  };
}

function runGit(args: string[], cwd: string): string | undefined {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 500,
  });
  if (result.status !== 0) return undefined;
  const value = result.stdout.trim();
  return value.length > 0 ? value : undefined;
}
