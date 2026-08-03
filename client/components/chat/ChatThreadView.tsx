import type { UIMessage } from "ai";
import {
  IconArrowLeft,
  IconLayoutSidebar,
  IconLayoutSidebarFilled,
} from "@tabler/icons-react";
import { useEffect } from "react";
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
  const chat = useAcpChat({
    threadId: thread.id,
    onStreamingChange: (streaming) => {
      if (!streaming) onStreamingSettled?.();
    },
  });

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

  const modelPicker = (
    <ChatModelPicker
      model={thread.model}
      onModelChange={handleModelChange}
      disabled={chat.status === "connecting"}
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

  if (chat.status === "connecting") {
    return (
      <ThreadShell
        showComposerMediaStubs={false}
        composerLeading={modelPicker}
      />
    );
  }

  if (chat.status === "displaced") {
    if (chat.reason === "model changed") {
      return (
        <ThreadShell
          showComposerMediaStubs={false}
          composerLeading={modelPicker}
        />
      );
    }
    return (
      <DisplacedProjectChat
        reason={chat.reason}
        messages={chat.messages}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {chat.connection === "reconnecting" ? <ReconnectingBanner /> : null}
      <AcpChatProvider
        key={chat.epoch}
        transport={chat.transport}
        messages={chat.messages}
      >
        <GrillTransportContext.Provider value={chat.transport}>
          <PermissionDataUI />
          <Thread
            sessionOpen={chat.sessionOpen}
            welcomeTitle={welcomeTitle}
            showComposerMediaStubs={false}
            openingPlaceholder="Warming agent — you can type…"
            composerLeading={modelPicker}
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
