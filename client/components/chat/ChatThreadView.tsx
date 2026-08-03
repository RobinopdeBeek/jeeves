import type { UIMessage } from "ai";
import type { BranchableTranscript } from "@shared/branchable-transcript";
import { emptyTranscript } from "@shared/branchable-transcript";
import {
  IconArrowLeft,
  IconLayoutSidebar,
  IconLayoutSidebarFilled,
} from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Thread, ThreadShell } from "@/components/assistant-ui/thread";
import { ChatModelPicker } from "@/components/chat/ChatModelPicker";
import { ProjectChatRewindProvider } from "@/components/chat/project-chat-rewind-context";
import { ReconnectingBanner } from "@/components/chat/ReconnectingBanner";
import { FrozenTranscriptView } from "@/components/grill/ReadOnlyTranscript";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { GrillTransportContext } from "@/components/grill/transport-context";
import { Button } from "@/components/ui/button";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import type { AcpChatTransport } from "@/hooks/acp-chat-transport";
import { api, type ChatThread } from "@/lib/api";
import {
  createProjectChatBranchAdapter,
  switchOpForBranch,
  truncateOpForEdit,
} from "@/lib/project-chat-rewind";
import { toast } from "sonner";

/** Live Project Chat thread — ACP over WS, user-first welcome, model picker. */
export function ChatThreadView({
  thread,
  showBack,
  railOpen,
  onToggleRail,
  onStreamingSettled,
  onThreadUpdated,
}: {
  thread: ChatThread | null;
  showBack?: boolean;
  /** Desktop rail visibility (omit on mobile). */
  railOpen?: boolean;
  onToggleRail?: () => void;
  /** Refresh the thread list after a turn (auto-title may have changed). */
  onStreamingSettled?: () => void;
  /** Keep parent list/active row in sync when the pinned model changes. */
  onThreadUpdated?: (thread: ChatThread) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-2">
        {showBack ? (
          <Button variant="ghost" size="icon-sm" asChild aria-label="Back to threads">
            <Link to="/chat">
              <IconArrowLeft data-icon="inline-start" />
            </Link>
          </Button>
        ) : null}
        {onToggleRail ? (
          <Button
            variant="ghost"
            size="icon-sm"
            type="button"
            aria-label={railOpen ? "Hide thread list" : "Show thread list"}
            aria-pressed={railOpen}
            onClick={onToggleRail}
          >
            {railOpen ? (
              <IconLayoutSidebarFilled data-icon="inline-start" />
            ) : (
              <IconLayoutSidebar data-icon="inline-start" />
            )}
          </Button>
        ) : null}
        <h1 className="truncate text-sm font-medium">
          {thread?.title.trim() || "Chat"}
        </h1>
      </div>
      {thread ? (
        <LiveProjectChat
          thread={thread}
          welcomeTitle={thread.title.trim() || "New Chat"}
          onStreamingSettled={onStreamingSettled}
          onThreadUpdated={onThreadUpdated}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
          Select or create a Chat Thread.
        </div>
      )}
    </div>
  );
}

function LiveProjectChat({
  thread,
  welcomeTitle,
  onStreamingSettled,
  onThreadUpdated,
}: {
  thread: ChatThread;
  welcomeTitle: string;
  onStreamingSettled?: () => void;
  onThreadUpdated?: (thread: ChatThread) => void;
}) {
  const [rewindEpoch, setRewindEpoch] = useState(0);
  const [pendingSend, setPendingSend] = useState<{
    text: string;
    key: string;
  } | null>(null);
  const [branchable, setBranchable] = useState<BranchableTranscript>(
    emptyTranscript(),
  );

  // Authoritative branch tree for the picker (reload-safe).
  useEffect(() => {
    let cancelled = false;
    void api
      .getChatThreadTranscript(thread.id)
      .then((t) => {
        if (!cancelled) setBranchable(t);
      })
      .catch(() => {
        /* picker stays empty until a successful load */
      });
    return () => {
      cancelled = true;
    };
  }, [thread.id, rewindEpoch]);

  return (
    <LiveProjectChatSession
      key={`${thread.id}:${thread.model ?? ""}:${rewindEpoch}`}
      thread={thread}
      welcomeTitle={welcomeTitle}
      branchable={branchable}
      pendingSend={pendingSend}
      onStreamingSettled={() => {
        onStreamingSettled?.();
        // Siblings may have been written after the turn — refresh picker.
        void api
          .getChatThreadTranscript(thread.id)
          .then(setBranchable)
          .catch(() => {});
      }}
      onThreadUpdated={onThreadUpdated}
      onAutoSendConsumed={() => setPendingSend(null)}
      onRewound={(next, sendText) => {
        setBranchable(next.branchable);
        setPendingSend(
          sendText
            ? { text: sendText, key: `${Date.now()}:${sendText.length}` }
            : null,
        );
        setRewindEpoch((n) => n + 1);
      }}
    />
  );
}

function LiveProjectChatSession({
  thread,
  welcomeTitle,
  branchable,
  pendingSend,
  onStreamingSettled,
  onThreadUpdated,
  onAutoSendConsumed,
  onRewound,
}: {
  thread: ChatThread;
  welcomeTitle: string;
  branchable: BranchableTranscript;
  pendingSend: { text: string; key: string } | null;
  onStreamingSettled?: () => void;
  onThreadUpdated?: (thread: ChatThread) => void;
  onAutoSendConsumed: () => void;
  onRewound: (
    result: { messages: UIMessage[]; branchable: BranchableTranscript },
    pendingSendText?: string,
  ) => void;
}) {
  const [rewinding, setRewinding] = useState(false);
  const transportRef = useRef<AcpChatTransport | null>(null);
  const branchableRef = useRef(branchable);
  branchableRef.current = branchable;

  const chat = useAcpChat({
    threadId: thread.id,
    onStreamingChange: (streaming) => {
      if (!streaming) onStreamingSettled?.();
    },
  });

  if (chat.status === "ready") {
    transportRef.current = chat.transport;
  }

  // If warm ACP was closed for a model change (this client or another), refresh
  // the thread row so the remount key picks up the persisted pin.
  useEffect(() => {
    if (chat.status !== "displaced" || chat.reason !== "model changed") return;
    let cancelled = false;
    void api
      .getChatThread(thread.id)
      .then((updated) => {
        if (!cancelled) onThreadUpdated?.(updated);
      })
      .catch(() => {
        /* keep shell until parent refreshes */
      });
    return () => {
      cancelled = true;
    };
  }, [chat, onThreadUpdated, thread.id]);

  async function handleModelChange(model: string | null) {
    try {
      // Persist + close warm ACP first so the remounted session reads the new pin.
      const updated = await api.setChatThreadModel(thread.id, model);
      onThreadUpdated?.(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not set model");
    }
  }

  async function runRewind(
    op: Parameters<typeof api.rewindChatThread>[1],
    sendText?: string,
  ) {
    const transport = transportRef.current;
    setRewinding(true);
    try {
      // Close our socket first so "rewound" displacement is expected teardown.
      transport?.close();
      const result = await api.rewindChatThread(thread.id, op);
      onRewound(result, sendText);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rewind chat");
      setRewinding(false);
      // Force remount to recover a live socket even if rewind failed mid-close.
      onRewound(
        { messages: [], branchable: branchableRef.current },
        undefined,
      );
    }
  }

  const branchAdapter = createProjectChatBranchAdapter({
    getBranchable: () => branchableRef.current,
    onSwitchBranch: (branchId) => {
      void runRewind(switchOpForBranch(branchId));
    },
  });

  const modelPicker = (
    <ChatModelPicker
      model={thread.model}
      onModelChange={handleModelChange}
      disabled={chat.status === "connecting" || rewinding}
    />
  );

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-destructive">Could not start Project Chat</p>
        <p className="max-w-md text-sm text-muted-foreground">{chat.error}</p>
      </div>
    );
  }

  if (chat.status === "connecting" || rewinding) {
    return <ThreadShell composerLeading={modelPicker} />;
  }

  if (chat.status === "displaced") {
    // Edit/branch rewind closes the warm slot; parent remounts on epoch bump.
    if (chat.reason === "rewound" || chat.reason === "model changed") {
      return <ThreadShell composerLeading={modelPicker} />;
    }
    return (
      <DisplacedProjectChat
        reason={chat.reason}
        messages={chat.messages}
      />
    );
  }

  const rewindDisabled =
    rewinding ||
    chat.connection === "reconnecting" ||
    !chat.sessionOpen;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {chat.connection === "reconnecting" ? <ReconnectingBanner /> : null}
      <AcpChatProvider
        key={`${chat.epoch}:${chat.attachmentsEnabled ? "att" : "plain"}`}
        transport={chat.transport}
        messages={chat.messages}
        promptCapabilities={chat.promptCapabilities}
        autoSendText={pendingSend?.text ?? null}
        autoSendKey={pendingSend?.key ?? null}
        sessionOpen={chat.sessionOpen}
        onAutoSendConsumed={onAutoSendConsumed}
      >
        <GrillTransportContext.Provider value={chat.transport}>
          <PermissionDataUI />
          <ProjectChatRewindProvider
            value={{
              getBranches: (id) => branchAdapter.getBranches(id),
              onSwitchBranch: (id) => branchAdapter.switchToBranch(id),
              onEditMessage: (messageId, text) => {
                void runRewind(
                  truncateOpForEdit(branchableRef.current, messageId),
                  text,
                );
              },
              disabled: rewindDisabled,
            }}
          >
            <Thread
              sessionOpen={chat.sessionOpen && !rewinding}
              welcomeTitle={welcomeTitle}
              attachmentsEnabled={chat.attachmentsEnabled}
              openingPlaceholder="Warming agent — you can type…"
              composerLeading={modelPicker}
            />
          </ProjectChatRewindProvider>
        </GrillTransportContext.Provider>
      </AcpChatProvider>
    </div>
  );
}

function DisplacedProjectChat({
  reason,
  messages,
}: {
  reason: string;
  messages: UIMessage[];
}) {
  const banner =
    reason === "session continued elsewhere"
      ? "Session continued elsewhere"
      : reason;

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        className="border-b bg-muted px-4 py-2 text-center text-sm text-muted-foreground"
        role="status"
      >
        {banner}
      </div>
      <FrozenTranscriptView messages={messages} />
    </div>
  );
}
