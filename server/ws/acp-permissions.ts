import type {
  PermissionOptionPart,
  PermissionRequestData,
} from "../../shared/chat-ws.js";

const READ_TOOL_RE =
  /\b(read|list|ls|glob|grep|search|find|cat|fetch|web.?search|context7|mcp)\b/i;
const WRITE_TOOL_RE =
  /\b(write|edit|delete|create|overwrite|apply.?patch|strreplace|shell|bash|terminal|cmd|powershell)\b/i;
const EXCHANGE_WRITE_RE = /\.jeeves[/\\]exchange\b/i;

export type HeadlessPermissionDecision =
  | { action: "allow"; optionId: string }
  | { action: "deny"; optionId: string | null; reason: string };

export type InteractivePermissionDecision =
  | { action: "allow"; optionId: string }
  | { action: "prompt" };

function permissionAllowOption(
  options: PermissionRequestData["options"],
): PermissionOptionPart | undefined {
  return options.find((o) => o.kind.startsWith("allow"));
}

function permissionRejectOption(
  options: PermissionRequestData["options"],
): PermissionOptionPart | undefined {
  return options.find((o) => o.kind.startsWith("reject"));
}

/** Classify a tool title for Cursor-like allow vs crucial-prompt. */
export function isRoutineOrExchangeAllow(title: string): boolean {
  const isExchangeWrite = EXCHANGE_WRITE_RE.test(title) && WRITE_TOOL_RE.test(title);
  const isRead = READ_TOOL_RE.test(title) && !WRITE_TOOL_RE.test(title);
  const isDisallowedWrite = WRITE_TOOL_RE.test(title) && !isExchangeWrite;
  if (isExchangeWrite || isRead) return true;
  if (isDisallowedWrite) return false;
  // Unknown non-write tools — treat as routine.
  return !WRITE_TOOL_RE.test(title);
}

/** Pick allow/deny for headless ACP without a permission UI. */
export function decideHeadlessPermission(
  data: Pick<PermissionRequestData, "title" | "options">,
): HeadlessPermissionDecision {
  const allow = permissionAllowOption(data.options);
  const reject = permissionRejectOption(data.options);
  const title = data.title ?? "";

  if (isRoutineOrExchangeAllow(title)) {
    if (allow) return { action: "allow", optionId: allow.optionId };
    return {
      action: "deny",
      optionId: reject?.optionId ?? null,
      reason: `headless ACP: no allow option for "${title || "tool"}"`,
    };
  }

  return {
    action: "deny",
    optionId: reject?.optionId ?? null,
    reason: `headless ACP: disallowed write "${title || "tool"}"`,
  };
}

/**
 * Live Cursor-like defaults: auto-approve reads/routine/exchange; prompt for crucial.
 */
export function decideInteractivePermission(
  data: Pick<PermissionRequestData, "title" | "options">,
): InteractivePermissionDecision {
  const allow = permissionAllowOption(data.options);
  const title = data.title ?? "";
  if (isRoutineOrExchangeAllow(title) && allow) {
    return { action: "allow", optionId: allow.optionId };
  }
  return { action: "prompt" };
}
