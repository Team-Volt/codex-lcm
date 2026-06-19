import type { Health } from "./storage.ts";

export type DoctorCheck = {
  id: string;
  label: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  recommendation?: string;
};

export type DoctorReport = {
  status: "ok" | "warn" | "fail";
  checks: DoctorCheck[];
  recommendations: string[];
  status_report: Record<string, unknown>;
  health: Health;
};

export function buildDoctorReport(args: {
  status: Record<string, unknown>;
  health: Health;
}): DoctorReport {
  const checks: DoctorCheck[] = [
    check(
      "plugin-wiring",
      "Codex plugin wiring",
      booleanValue(args.status.plugin_configured) && booleanValue(args.status.mcp_configured) && booleanValue(args.status.hooks_configured),
      "codex-lcm is configured as a Codex plugin with MCP and hooks.",
      "codex-lcm is not fully wired into Codex.",
      "Run `codex plugin add codex-lcm@codex-lcm`, then restart Codex so MCP and hooks load.",
    ),
    check(
      "recall-skill",
      "LCM recall skill",
      booleanValue(args.status.recall_skill_available),
      "The lcm-recall skill is available.",
      "The lcm-recall skill is missing from the plugin root.",
      "Reinstall the plugin with `codex plugin add codex-lcm@codex-lcm`.",
    ),
    check(
      "storage-index",
      "Storage index",
      args.health.index_available,
      `SQLite index is available at ${args.health.index_path}.`,
      args.health.index_error ? `SQLite index is unavailable: ${args.health.index_error}` : `SQLite index is unavailable at ${args.health.index_path}.`,
      "Run `codex-lcm health --json`; if the index is corrupt, move it aside and re-import or let hooks rebuild it.",
      args.health.index_error ? "fail" : "warn",
    ),
    check(
      "event-capture",
      "Event capture",
      args.health.event_count > 0,
      `${args.health.event_count} events are indexed.`,
      "No LCM events are indexed yet.",
      "Start a new Codex session after installing hooks, or run `codex-lcm import-codex-sessions` to backfill existing sessions.",
    ),
    summaryIndexCheck(args.health),
  ];
  const recommendations = checks
    .filter((item) => item.status !== "ok" && item.recommendation)
    .map((item) => item.recommendation as string);
  return {
    status: checks.some((item) => item.status === "fail") ? "fail" : checks.some((item) => item.status === "warn") ? "warn" : "ok",
    checks,
    recommendations,
    status_report: args.status,
    health: args.health,
  };
}

function summaryIndexCheck(health: Health): DoctorCheck {
  if (!health.index_available) {
    return {
      id: "summary-index",
      label: "Summary index",
      status: "warn",
      detail: "Summary-node counts could not be checked because the SQLite index is unavailable.",
      recommendation: "Fix the storage-index check first; summaries are stored in the SQLite index.",
    };
  }
  return check(
    "summary-index",
    "Summary index",
    (health.summary_node_count ?? 0) > 0 || health.event_count === 0,
    `${health.summary_node_count ?? 0} summary nodes are indexed.`,
    "Events exist but no summary nodes are indexed.",
    "Run `codex-lcm stats --json`; new high-signal events should rebuild summaries automatically.",
  );
}

function check(
  id: string,
  label: string,
  passed: boolean,
  okDetail: string,
  problemDetail: string,
  recommendation: string,
  problemStatus: "warn" | "fail" = "warn",
): DoctorCheck {
  return passed
    ? { id, label, status: "ok", detail: okDetail }
    : { id, label, status: problemStatus, detail: problemDetail, recommendation };
}

function booleanValue(value: unknown): boolean {
  return value === true;
}
