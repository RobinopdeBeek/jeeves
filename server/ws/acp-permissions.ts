import type {
  PermissionOptionPart,
  PermissionRequestData,
} from "../../shared/chat-ws.js";

const READ_TOOL_RE =
  /\b(read|list|ls|glob|grep|search|find|cat|fetch|web.?search|context7|mcp)\b/i;
/** Explicit shell/tool labels from ACP. */
const SHELL_LABEL_RE = /\b(shell|bash|terminal|cmd|powershell)\b/i;
/**
 * Raw command titles often omit a "Shell:" prefix (rg, dir, Select-String, …).
 * Matched at the start of the title after trimming / stripping fences.
 */
const SHELL_CLI_RE =
  /^(rg|grep|dir|ls|cat|find|select-string|format-hex|get-content|get-item|write-host|npm|npx|git|node|python|pwsh|curl|wget)\b/i;
/** File-mutating ACP titles — require "write/edit file", not bare "Write" in args. */
const FILE_WRITE_TOOL_RE =
  /\b((write|edit|delete|create|overwrite)\s+files?|apply.?patch|str.?replace)\b/i;
const EXCHANGE_PATH_RE = /\.jeeves[/\\]exchange\b/i;

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

/** ACP sometimes wraps raw command titles in backticks. */
function normalizeToolTitle(title: string): string {
  return title.trim().replace(/^`+|`+$/g, "").trim();
}

function isExchangePath(title: string): boolean {
  return EXCHANGE_PATH_RE.test(title);
}

function isExchangeWrite(title: string): boolean {
  return isExchangePath(title) && FILE_WRITE_TOOL_RE.test(title);
}

function isShellTool(title: string): boolean {
  const t = normalizeToolTitle(title);
  if (SHELL_LABEL_RE.test(t)) return true;
  if (SHELL_CLI_RE.test(t)) return true;
  // PowerShell pipelines in raw titles (e.g. `rg … | Select-Object`).
  if (/\|\s*Select-Object\b/i.test(t)) return true;
  return false;
}

function isFileWriteTool(title: string): boolean {
  return FILE_WRITE_TOOL_RE.test(normalizeToolTitle(title));
}

/**
 * Headless allow-list: reads, exchange file writes, and shell that only
 * touches the exchange path (agents often verify the JSON via Get-Content).
 * Other shell and non-exchange writes are denied (never stalls on a UI).
 */
export function isRoutineOrExchangeAllow(title: string): boolean {
  if (isExchangeWrite(title)) return true;
  if (isShellTool(title)) return isExchangePath(title);
  if (isFileWriteTool(title)) return false;
  if (READ_TOOL_RE.test(title)) return true;
  // Unknown non-write tools — treat as routine.
  return true;
}

/**
 * Interactive Cursor-like allow-list: reads, shell, and exchange writes.
 * Only non-exchange file writes still prompt (project-mutating edits).
 */
export function isInteractiveAutoAllow(title: string): boolean {
  if (isExchangeWrite(title)) return true;
  // Shell before file-write: command text may contain the word "Write".
  if (isShellTool(title)) return true;
  if (isFileWriteTool(title)) return false;
  return true;
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
 * Live Cursor-like defaults: auto-approve reads/shell/exchange; prompt for
 * non-exchange file writes.
 */
export function decideInteractivePermission(
  data: Pick<PermissionRequestData, "title" | "options">,
): InteractivePermissionDecision {
  const allow = permissionAllowOption(data.options);
  const title = data.title ?? "";
  if (isInteractiveAutoAllow(title) && allow) {
    return { action: "allow", optionId: allow.optionId };
  }
  return { action: "prompt" };
}
