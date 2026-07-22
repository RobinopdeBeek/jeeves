import { useChatRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ChatTransport, UIMessage } from "ai";
import { AcpChatTransport } from "./acp-chat-transport";

export interface UseAcpChatOptions {
  cardId: string;
  stepKey: string;
  round?: number;
}

export interface AcpChatReady {
  transport: AcpChatTransport;
  messages: UIMessage[];
}

/**
 * Custom ChatTransport hook: connects Grill (and future ai-chat steps) to AcpBridge.
 * Returns null until the server `ready` handshake arrives with transcript history.
 */
export function useAcpChat({
  cardId,
  stepKey,
  round = 0,
}: UseAcpChatOptions): AcpChatReady | null {
  const transport = useMemo(
    () => new AcpChatTransport({ cardId, stepKey, round }),
    [cardId, stepKey, round],
  );
  const [messages, setMessages] = useState<UIMessage[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    void transport.connect().then((history) => {
      if (!cancelled) setMessages(history);
    });
    return () => {
      cancelled = true;
      transport.close();
    };
  }, [transport]);

  if (!messages) return null;
  return { transport, messages };
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
