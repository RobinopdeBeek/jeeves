import { useChat } from "@ai-sdk/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatTransport, UIMessage } from "ai";
import type { PromptCapabilities } from "@shared/chat-ws";
import type { BranchableTranscript } from "@shared/branchable-transcript";
import {
  attachmentAcceptFor,
  EMPTY_PROMPT_CAPABILITIES,
} from "@shared/prompt-capabilities";
import type { TasksDraftTip } from "@/lib/api";
import { createAcpAttachmentAdapter } from "./acp-attachment-adapter";
import {
  AcpChatTransport,
  type ChatConnectionState,
} from "./acp-chat-transport";

function capsFromTransport(transport: AcpChatTransport): {
  promptCapabilities: PromptCapabilities;
  attachmentsEnabled: boolean;
} {
  const promptCapabilities = transport.getPromptCapabilities();
  return {
    promptCapabilities,
    attachmentsEnabled: attachmentAcceptFor(promptCapabilities).length > 0,
  };
}

export interface UseAcpChatOptions {
  /** Step chat coordinates. Mutually exclusive with threadId. */
  cardId?: string;
  stepKey?: string;
  round?: number;
  /** Project Chat Thread id. Mutually exclusive with cardId/stepKey. */
  threadId?: string;
  /** Live editor/tip draft for Define assist steps (opaque body; server frames by profile). */
  getLiveDraftBody?: () => string;
  onSpecRevised?: (markdown: string) => void;
  onTasksRevised?: (draft: TasksDraftTip) => void;
  onStreamingChange?: (streaming: boolean) => void;
  /**
   * Displace reasons that soft-reattach instead of freezing the transcript
   * (Project Chat Rewind → "rewound").
   */
  softDisplaceReasons?: readonly string[];
  /** Project Chat: authoritative branchable from WS ready / reconnect. */
  onBranchable?: (branchable: BranchableTranscript) => void;
}

export type AcpChatState =
  | { status: "connecting" }
  | {
      status: "ready";
      transport: AcpChatTransport;
      messages: UIMessage[];
      /** ACP handshake done — composer send is allowed. */
      sessionOpen: boolean;
      /** Socket health; "reconnecting" drives the recovery hint. */
      connection: ChatConnectionState;
      /**
       * Bumped when a reconnect delivers a fresh transcript. Callers key the
       * chat runtime on it so recovery re-seeds history (like remounting).
       */
      epoch: number;
      /** Negotiated ACP prompt attachment kinds (gates the composer paperclip). */
      promptCapabilities: PromptCapabilities;
      /** True when the session advertises at least one attachable kind. */
      attachmentsEnabled: boolean;
    }
  | {
      status: "displaced";
      reason: string;
      /** Last messages seen on the live socket before displacement (may be stale). */
      messages: UIMessage[];
    }
  | { status: "error"; error: string };

/**
 * Custom ChatTransport hook: connects Grill / Spec / Tasks / Project Chat to AcpBridge.
 *
 * The transport heals its own socket; this hook mirrors that into UI state and
 * re-seeds the runtime from the server transcript after a reconnect.
 */
export function useAcpChat({
  cardId,
  stepKey,
  round = 0,
  threadId,
  getLiveDraftBody,
  onSpecRevised,
  onTasksRevised,
  onStreamingChange,
  softDisplaceReasons = [],
  onBranchable,
}: UseAcpChatOptions): AcpChatState {
  const [state, setState] = useState<AcpChatState>({ status: "connecting" });
  const getLiveDraftRef = useRef(getLiveDraftBody);
  getLiveDraftRef.current = getLiveDraftBody;
  const onRevisedRef = useRef(onSpecRevised);
  onRevisedRef.current = onSpecRevised;
  const onTasksRevisedRef = useRef(onTasksRevised);
  onTasksRevisedRef.current = onTasksRevised;
  const onStreamingRef = useRef(onStreamingChange);
  onStreamingRef.current = onStreamingChange;
  const onBranchableRef = useRef(onBranchable);
  onBranchableRef.current = onBranchable;
  const softDisplaceRef = useRef(softDisplaceReasons);
  softDisplaceRef.current = softDisplaceReasons;
  const injectLiveDraft = getLiveDraftBody != null;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "connecting" });

    const transport = new AcpChatTransport({
      cardId,
      stepKey,
      round,
      threadId,
      getLiveDraftBody: injectLiveDraft
        ? () => getLiveDraftRef.current?.() ?? ""
        : undefined,
      onSpecRevised: (markdown) => onRevisedRef.current?.(markdown),
      onTasksRevised: (draft) => onTasksRevisedRef.current?.(draft),
      onStreamingChange: (streaming) => onStreamingRef.current?.(streaming),
      onBranchable: (branchable) => onBranchableRef.current?.(branchable),
      softDisplaceReasons: softDisplaceRef.current,
      onConnectionChange: (connection) => {
        if (cancelled) return;
        setState((prev) => {
          if (prev.status !== "ready") return prev;
          // Keep sessionOpen across reconnect so Stop stays visible mid-turn.
          // Only a hard close hides Send/Cancel (spinner).
          const sessionOpen =
            connection === "closed"
              ? false
              : connection === "open"
                ? true
                : prev.sessionOpen;
          return {
            ...prev,
            connection,
            sessionOpen,
            ...capsFromTransport(transport),
          };
        });
      },
      onReconnected: (history, opts) => {
        if (cancelled) return;
        if (opts.branchable) onBranchableRef.current?.(opts.branchable);
        setState((prev) =>
          prev.status === "ready" || prev.status === "connecting"
            ? {
                status: "ready",
                transport,
                messages: history,
                sessionOpen: transport.isSessionOpen(),
                connection: transport.getConnectionState(),
                epoch:
                  prev.status === "ready" ? prev.epoch + 1 : Date.now(),
                ...capsFromTransport(transport),
              }
            : prev,
        );
      },
      onDisplaced: (reason) => {
        if (cancelled) return;
        if (softDisplaceRef.current.includes(reason)) {
          // Soft path: transport already reconnecting; mirror reconnecting UI.
          setState((prev) =>
            prev.status === "ready"
              ? {
                  ...prev,
                  sessionOpen: false,
                  connection: "reconnecting",
                  ...capsFromTransport(transport),
                }
              : prev,
          );
          return;
        }
        setState((prev) => ({
          status: "displaced",
          reason,
          messages: prev.status === "ready" ? prev.messages : [],
        }));
      },
    });

    void transport
      .connect()
      .then((history) => {
        if (cancelled) return;
        setState({
          status: "ready",
          transport,
          messages: history,
          sessionOpen: transport.isSessionOpen(),
          connection: transport.getConnectionState(),
          epoch: 0,
          ...capsFromTransport(transport),
        });
        void transport
          .whenSessionOpen()
          .then(() => {
            if (cancelled) return;
            setState((prev) =>
              prev.status === "ready"
                ? {
                    ...prev,
                    sessionOpen: true,
                    connection: "open",
                    ...capsFromTransport(transport),
                  }
                : prev,
            );
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            setState((prev) => {
              if (prev.status === "displaced") return prev;
              return {
                status: "error",
                error: err instanceof Error ? err.message : String(err),
              };
            });
          });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState((prev) => {
            if (prev.status === "displaced") return prev;
            return {
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            };
          });
        }
      });

    return () => {
      cancelled = true;
      // CONNECTING-safe close waits for open before closing (no setTimeout defer).
      transport.close();
    };
  }, [cardId, stepKey, round, threadId, injectLiveDraft]);

  return state;
}

/**
 * Mount assistant-ui runtime once the WebSocket handshake has history.
 *
 * Uses useChat + useAISDKRuntime with a stable id (not useChatRuntime's
 * RemoteThreadList). Thread-list id churn recreates Chat without re-firing
 * resume, which dropped the opening grill turn until a tab remount loaded
 * the finished transcript.
 */
export function AcpChatProvider({
  transport,
  messages,
  promptCapabilities = EMPTY_PROMPT_CAPABILITIES,
  /**
   * After rewind remount: send this user text once the chat runtime is up
   * and the ACP session is open (edit-and-send). Cleared via onAutoSendConsumed.
   */
  autoSendText,
  autoSendKey,
  sessionOpen = true,
  onAutoSendConsumed,
  children,
}: {
  transport: AcpChatTransport;
  messages: UIMessage[];
  promptCapabilities?: PromptCapabilities;
  autoSendText?: string | null;
  /** Unique per edit-and-send so identical text can be resent. */
  autoSendKey?: string | null;
  sessionOpen?: boolean;
  onAutoSendConsumed?: () => void;
  children: ReactNode;
}) {
  const chat = useChat({
    // Stable for this provider mount. useChatRuntime's RemoteThreadList id
    // churn recreates Chat without re-calling resumeStream.
    id: "acp-chat",
    transport: transport as ChatTransport<UIMessage>,
    messages,
    resume: true,
  });
  const autoSendConsumedKey = useRef<string | null>(null);
  useEffect(() => {
    if (!autoSendText || !autoSendKey || !sessionOpen) return;
    if (autoSendConsumedKey.current === autoSendKey) return;
    autoSendConsumedKey.current = autoSendKey;
    void chat.sendMessage({
      role: "user",
      parts: [{ type: "text", text: autoSendText }],
    });
    onAutoSendConsumed?.();
  }, [autoSendText, autoSendKey, sessionOpen, chat, onAutoSendConsumed]);

  // Nested @ai-sdk/react inside react-ai-sdk can disagree on UseChatHelpers.
  const runtime = useAISDKRuntime(
    chat as unknown as Parameters<typeof useAISDKRuntime>[0],
    {
      adapters: {
        attachments: createAcpAttachmentAdapter(promptCapabilities),
      },
    },
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
  );
}
