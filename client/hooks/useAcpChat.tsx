import { useChat } from "@ai-sdk/react";
import { useAISDKRuntime } from "@assistant-ui/react-ai-sdk";
import { AssistantRuntimeProvider } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatTransport, UIMessage } from "ai";
import type { PromptCapabilities } from "@shared/chat-ws";
import type { BranchableTranscript } from "@shared/branchable-transcript";
import {
  attachmentAcceptFor,
  hasNoPromptCapabilities,
  EMPTY_PROMPT_CAPABILITIES,
  OPTIMISTIC_PROMPT_CAPABILITIES,
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
  const negotiated = transport.getPromptCapabilities();
  // Before the handshake reports anything, assume images so the paperclip is
  // live from the first paint. Also keeps `attachmentsEnabled` from flipping
  // once real caps land, which would remount the chat runtime mid-typing.
  const promptCapabilities = hasNoPromptCapabilities(negotiated)
    ? OPTIMISTIC_PROMPT_CAPABILITIES
    : negotiated;
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
  | {
      status: "ready";
      transport: AcpChatTransport;
      messages: UIMessage[];
      /** ACP handshake done. Sends are parked (not refused) until then. */
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
      /**
       * The agent failed to start. The composer stays live and the next send
       * retries — never an error screen that discards the typed message.
       */
      sessionError: string | null;
    }
  | {
      status: "displaced";
      reason: string;
      /** Last messages seen on the live socket before displacement (may be stale). */
      messages: UIMessage[];
    }
  | { status: "error"; error: string };

/**
 * Live from the first frame: the transport is already there, history is empty
 * and `sessionOpen` is false. No caller ever swaps components during startup.
 */
function liveState(transport: AcpChatTransport): AcpChatState {
  return {
    status: "ready",
    transport,
    messages: [],
    sessionOpen: transport.isSessionOpen(),
    connection: transport.getConnectionState(),
    epoch: 0,
    sessionError: null,
    ...capsFromTransport(transport),
  };
}

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
  const [state, setState] = useState<AcpChatState | null>(null);
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
  const identity = [
    cardId ?? "",
    stepKey ?? "",
    String(round),
    threadId ?? "",
    injectLiveDraft ? "draft" : "",
  ].join("|");

  /** Ignore updates from a transport that a chat identity change superseded. */
  const liveTransport = useRef<AcpChatTransport | null>(null);
  function apply(
    transport: AcpChatTransport,
    next: (prev: AcpChatState) => AcpChatState,
  ): void {
    if (liveTransport.current !== transport) return;
    setState((prev) => next(prev ?? liveState(transport)));
  }

  // Constructing a transport opens nothing (connect() does), so it is safe to
  // build during render — which is what lets the very first paint carry a live
  // composer instead of a startup shell.
  function buildTransport(): AcpChatTransport {
    const transport: AcpChatTransport = new AcpChatTransport({
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
      onSessionError: (error) => {
        apply(transport, (prev) =>
          prev.status === "ready" ? { ...prev, sessionError: error } : prev,
        );
      },
      onConnectionChange: (connection) => {
        apply(transport, (prev) => {
          if (prev.status !== "ready") return prev;
          // Keep sessionOpen across reconnect so Stop stays visible mid-turn.
          // Only a hard close hides Send/Cancel.
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
            // Any fresh attempt clears the last startup failure.
            sessionError: connection === "closed" ? prev.sessionError : null,
            ...capsFromTransport(transport),
          };
        });
      },
      onReconnected: (history, opts) => {
        if (opts.branchable) onBranchableRef.current?.(opts.branchable);
        apply(transport, (prev) =>
          prev.status === "ready"
            ? {
                ...prev,
                messages: history,
                sessionOpen: transport.isSessionOpen(),
                connection: transport.getConnectionState(),
                epoch: prev.epoch + 1,
                ...capsFromTransport(transport),
              }
            : prev,
        );
      },
      onDisplaced: (reason) => {
        if (softDisplaceRef.current.includes(reason)) {
          // Soft path: transport already reconnecting; mirror reconnecting UI.
          apply(transport, (prev) =>
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
        apply(transport, (prev) => ({
          status: "displaced",
          reason,
          messages: prev.status === "ready" ? prev.messages : [],
        }));
      },
    });
    return transport;
  }

  const [entry, setEntry] = useState(() => ({
    identity,
    transport: buildTransport(),
  }));
  let current = entry;
  let currentState = state;
  if (entry.identity !== identity) {
    current = { identity, transport: buildTransport() };
    currentState = null;
    setEntry(current);
    setState(null);
  }
  liveTransport.current = current.transport;
  const transport = current.transport;
  const startupState = useMemo(() => liveState(transport), [transport]);

  useEffect(() => {
    void transport
      .connect()
      .then((history) => {
        apply(transport, (prev) => {
          if (prev.status !== "ready") return prev;
          const synced = {
            ...prev,
            sessionOpen: transport.isSessionOpen(),
            connection: transport.getConnectionState(),
            ...capsFromTransport(transport),
          };
          // Re-seeding remounts the chat runtime, so only pay for it when there
          // is history to seed — a brand-new chat never remounts.
          return history.length > 0
            ? { ...synced, messages: history, epoch: prev.epoch + 1 }
            : synced;
        });
        void transport
          .whenSessionOpen()
          .then(() => {
            apply(transport, (prev) =>
              prev.status === "ready"
                ? {
                    ...prev,
                    sessionOpen: true,
                    connection: "open",
                    sessionError: null,
                    ...capsFromTransport(transport),
                  }
                : prev,
            );
          })
          .catch((err: unknown) => {
            apply(transport, (prev) =>
              prev.status === "ready"
                ? { ...prev, sessionError: errorText(err) }
                : prev,
            );
          });
      })
      .catch((err: unknown) => {
        // The socket itself is unreachable — there is no chat to keep live.
        apply(transport, (prev) =>
          prev.status === "displaced"
            ? prev
            : { status: "error", error: errorText(err) },
        );
      });

    return () => {
      // CONNECTING-safe close waits for open before closing (no setTimeout defer).
      transport.close();
    };
  }, [transport]);

  return currentState ?? startupState;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
