import type { UIMessage, UIMessageChunk } from "ai";

/** Client-visible permission option projected from ACP (no ACP types leak). */
export type PermissionOptionPart = {
  optionId: string;
  name: string;
  kind: string;
};

/** AI SDK `data-permission` payload for inline approve/deny UI. */
export type PermissionRequestData = {
  requestId: string;
  toolCallId?: string;
  title?: string;
  options: PermissionOptionPart[];
  status: "pending" | "resolved";
  selectedOptionId?: string;
};

export type WsClientMessage =
  | { type: "user-message"; text: string }
  | { type: "permission-response"; requestId: string; optionId: string };

export type WsServerMessage =
  | { type: "ready"; messages: UIMessage[]; streaming?: boolean }
  /** ACP handshake finished — client may send user turns. */
  | { type: "session"; status: "open"; streaming?: boolean }
  | { type: "chunk"; chunk: UIMessageChunk }
  | { type: "status"; status: "ai-working" | "needs-user" }
  | { type: "displaced"; reason: string }
  | { type: "error"; error: string };
