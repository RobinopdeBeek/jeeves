import { useChat } from "@ai-sdk/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatTransport, UIMessage } from "ai";
import type { TasksDraftTip } from "@/lib/api";
import {
  AcpChatTransport,
  type ChatConnectionState,
} from "./acp-chat-transport";

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
          return { ...prev, connection, sessionOpen };
        });
      },
      onReconnected: (history) => {
        if (cancelled) return;
        setState((prev) =>
          prev.status === "ready"
            ? { ...prev, messages: history, epoch: prev.epoch + 1 }
            : prev,
        );
      },
      onDisplaced: (reason) => {
        if (cancelled) return;
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
        });
        void transport
          .whenSessionOpen()
          .then(() => {
            if (cancelled) return;
            setState((prev) =>
              prev.status === "ready"
                ? { ...prev, sessionOpen: true, connection: "open" }
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
  children,
}: {
  transport: AcpChatTransport;
  messages: UIMessage[];
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
  // Nested @ai-sdk/react inside react-ai-sdk can disagree on UseChatHelpers.
  const runtime = useAISDKRuntime(
    chat as unknown as Parameters<typeof useAISDKRuntime>[0],
  );
  return (
    <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
  );
}
