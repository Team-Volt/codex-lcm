export const CODEX_HOOK_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "SubagentStop",
  "Stop",
] as const;

export type CodexHookName = (typeof CODEX_HOOK_NAMES)[number];

export type ContextCapableHook = Extract<CodexHookName, "SessionStart" | "UserPromptSubmit" | "PostToolUse">;

export type HookStdout =
  | { readonly kind: "empty" }
  | {
    readonly kind: "additionalContext";
    readonly hookEventName: ContextCapableHook;
    readonly additionalContext: string;
  }
  | { readonly kind: "stopBlock"; readonly reason: string };

export type HookStdoutKind = "empty" | "additionalContext" | "stopDecision";

export type HookCapability = {
  readonly stdout: HookStdoutKind;
};

export const CODEX_HOST = {
  id: "codex",
  pluginRootToken: "${PLUGIN_ROOT}",
  hooks: {
    SessionStart: { stdout: "additionalContext" },
    UserPromptSubmit: { stdout: "additionalContext" },
    PreToolUse: { stdout: "empty" },
    PostToolUse: { stdout: "additionalContext" },
    PreCompact: { stdout: "empty" },
    PostCompact: { stdout: "empty" },
    SubagentStop: { stdout: "empty" },
    Stop: { stdout: "stopDecision" },
  },
} as const satisfies {
  readonly id: "codex";
  readonly pluginRootToken: "${PLUGIN_ROOT}";
  readonly hooks: { readonly [K in CodexHookName]: HookCapability };
};

export function parseCodexHookName(value: string): CodexHookName | undefined {
  return (CODEX_HOOK_NAMES as readonly string[]).includes(value) ? value as CodexHookName : undefined;
}

type HookStdoutFor<Event extends CodexHookName> =
  | Extract<HookStdout, { kind: "empty" }>
  | (Event extends ContextCapableHook
    ? Extract<HookStdout, { kind: "additionalContext" }> & { readonly hookEventName: Event }
    : Event extends "Stop"
      ? Extract<HookStdout, { kind: "stopBlock" }>
      : never);

type HookStdoutArgs = {
  [Event in CodexHookName]: [event: Event, stdout: HookStdoutFor<Event>];
}[CodexHookName];

export function encodeHookStdout(...[event, stdout]: HookStdoutArgs): string {
  return encodeDynamicHookStdout(event, stdout);
}

// Dynamic hook input must be validated at runtime, without weakening the literal API.
export function encodeDynamicHookStdout(event: string, stdout: HookStdout): string {
  const name = parseCodexHookName(event);
  if (!name) {
    if (stdout.kind !== "empty") {
      throw new Error(`codex-lcm: ${event} is not a Codex hook and cannot emit stdout`);
    }
    return "";
  }
  const allowed = CODEX_HOST.hooks[name].stdout;
  if (stdout.kind === "empty") return "";
  if (stdout.kind === "additionalContext") {
    if (allowed !== "additionalContext") {
      throw new Error(`codex-lcm: ${name} cannot emit additionalContext`);
    }
    if (stdout.hookEventName !== name) {
      throw new Error(`codex-lcm: ${name} cannot emit additionalContext for ${stdout.hookEventName}`);
    }
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: stdout.hookEventName,
        additionalContext: stdout.additionalContext,
      },
    })}\n`;
  }
  if (stdout.kind === "stopBlock") {
    if (allowed !== "stopDecision") {
      throw new Error(`codex-lcm: ${name} cannot emit a stop decision`);
    }
    return `${JSON.stringify({ decision: "block", reason: stdout.reason })}\n`;
  }
  const unexpected: never = stdout;
  return unexpected;
}
