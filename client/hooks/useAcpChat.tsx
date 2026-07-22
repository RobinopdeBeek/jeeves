import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
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
  | { status: "ready"; transport: AcpChatTransport; messages: UIMessage[] }
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
    const transport = new AcpChatTransport({ cardId, stepKey, round });
    setState({ status: "connecting" });

    // Defer past React Strict Mode's sync mount→cleanup→remount. Opening the
    // socket in the first (discarded) setup closes it while CONNECTING, which
    // logs a browser warning and an ECONNRESET on Vite's WS proxy.
    const startId = window.setTimeout(() => {
      if (cancelled) return;
      void transport
        .connect()
        .then((history) => {
          if (!cancelled) {
            setState({ status: "ready", transport, messages: history });
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setState({
              status: "error",
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(startId);
      transport.close();
    };
  }, [cardId, stepKey, round]);

  return state;
}

/** Mount assistant-ui runtime once the WebSocket handshake has history. */
export function AcpChatProvider({
  transport,
  messages,
  children,
}: {
  transport: AcpChatTransport;
  messages: UIMessage[];
  children: ReactNode;
}) {
  // `resume` is on useChat; assistant-ui's options type omits it — still forwarded at runtime.
  const runtime = useChatRuntime({
    transport: transport as unknown as ChatTransport<UIMessage>,
    messages,
    resume: true,
  } as Parameters<typeof useChatRuntime>[0]);
  return (
    <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
  );
}
