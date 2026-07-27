import { useChat } from "@ai-sdk/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useState, type ReactNode } from "react";
import type { ChatTransport, UIMessage } from "ai";
import { AcpChatTransport } from "./acp-chat-transport";

export interface UseAcpChatOptions {
  cardId: string;
  stepKey: string;
  round?: number;
}

export type AcpChatState =
  | { status: "connecting" }
  | {
      status: "ready";
      transport: AcpChatTransport;
      messages: UIMessage[];
      /** ACP handshake done — composer send is allowed. */
      sessionOpen: boolean;
    }
  | {
      status: "displaced";
      reason: string;
      /** Last messages seen on the live socket before displacement (may be stale). */
      messages: UIMessage[];
    }
  | { status: "error"; error: string };

/**
 * Custom ChatTransport hook: connects Grill (and future ai-chat steps) to AcpBridge.
 */
export function useAcpChat({
  cardId,
  stepKey,
  round = 0,
}: UseAcpChatOptions): AcpChatState {
  const [state, setState] = useState<AcpChatState>({ status: "connecting" });

  useEffect(() => {
    let cancelled = false;
    setState({ status: "connecting" });

    const transport = new AcpChatTransport({
      cardId,
      stepKey,
      round,
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
        });
        void transport
          .whenSessionOpen()
          .then(() => {
            if (cancelled) return;
            setState((prev) =>
              prev.status === "ready" ? { ...prev, sessionOpen: true } : prev,
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
  }, [cardId, stepKey, round]);

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
