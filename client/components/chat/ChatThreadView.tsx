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
import { ReconnectingBanner } from "@/components/chat/ReconnectingBanner";
import { FrozenTranscriptView } from "@/components/grill/ReadOnlyTranscript";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { GrillTransportContext } from "@/components/grill/transport-context";
import { Button } from "@/components/ui/button";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
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
          // Remount on model pin change (spawn identity); soft-reattach on Rewind.
          key={`${thread.id}:${thread.model ?? ""}`}
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
  const [rewinding, setRewinding] = useState(false);
  const [pendingSend, setPendingSend] = useState<{
    text: string;
    key: string;
  } | null>(null);
  const [branchable, setBranchable] = useState<BranchableTranscript>(
    emptyTranscript(),
  );
  const branchableRef = useRef(branchable);
  branchableRef.current = branchable;

  const chat = useAcpChat({
    threadId: thread.id,
    softDisplaceReasons: ["rewound"],
    onBranchable: setBranchable,
    onStreamingChange: (streaming) => {
      if (!streaming) onStreamingSettled?.();
    },
  });

  // Model pin changed elsewhere → refresh row so the remount key picks it up.
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
    setRewinding(true);
    try {
      // Keep the socket open so "rewound" soft-displaces and reattaches.
      const result = await api.rewindChatThread(thread.id, op);
      setBranchable(result.branchable);
      if (result.warm.status === "failed") {
        toast.error(result.warm.error || "Warm agent failed to respawn");
      }
      setPendingSend(
        sendText
          ? { text: sendText, key: `${Date.now()}:${sendText.length}` }
          : null,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rewind chat");
    } finally {
      setRewinding(false);
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
    // Soft "rewound" never lands here; model change remounts via key.
    if (chat.reason === "model changed") {
      return <ThreadShell composerLeading={modelPicker} />;
    }
    return (
      <DisplacedProjectChat reason={chat.reason} messages={chat.messages} />
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
        onAutoSendConsumed={() => setPendingSend(null)}
      >
        <GrillTransportContext.Provider value={chat.transport}>
          <PermissionDataUI />
          <Thread
            sessionOpen={chat.sessionOpen && !rewinding}
            welcomeTitle={welcomeTitle}
            attachmentsEnabled={chat.attachmentsEnabled}
            openingPlaceholder="Warming agent — you can type…"
            composerLeading={modelPicker}
            rewind={{
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
          />
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
  messages: import("ai").UIMessage[];
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
