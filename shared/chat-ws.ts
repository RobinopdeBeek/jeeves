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
  | {
      type: "user-message";
      /** User-visible chat text (and transcript). */
      text: string;
      /**
       * Live editor/tip draft for Define assist steps. Server frames this into
       * the agent prompt only — it must not appear in the chat transcript.
       * Kind is implied by the step; body is opaque to the transport.
       */
      liveDraftBody?: string;
    }
  | { type: "permission-response"; requestId: string; optionId: string }
  /** Liveness probe; answered with `pong`. Never touches the ACP session. */
  | { type: "ping"; id: string };

export type WsServerMessage =
  | { type: "ready"; messages: UIMessage[]; streaming?: boolean }
  /** ACP handshake finished — client may send user turns. */
  | { type: "session"; status: "open"; streaming?: boolean }
  | { type: "chunk"; chunk: UIMessageChunk }
  | { type: "status"; status: "ai-working" | "needs-user" }
  /** Answer to a client `ping` — proves the socket is not half-open. */
  | { type: "pong"; id: string }
  /** Spec side-chat harvested a revision — replace editor content. */
  | { type: "spec-revised"; markdown: string }
  /** Tasks side-chat harvested a revision — replace tip tiles. */
  | {
      type: "tasks-revised";
      draft: {
        tasks: Array<{
          id: string;
          title: string;
          description: string;
          dependsOn: string[];
        }>;
      };
      versionCount: number;
    }
  | { type: "displaced"; reason: string }
  | { type: "error"; error: string };
