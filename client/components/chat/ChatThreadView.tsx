import type { UIMessage } from "ai";
import {
  IconArrowLeft,
  IconLayoutSidebar,
  IconLayoutSidebarFilled,
} from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { Thread, ThreadShell } from "@/components/assistant-ui/thread";
import { ReconnectingBanner } from "@/components/chat/ReconnectingBanner";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { GrillTransportContext } from "@/components/grill/transport-context";
import { Button } from "@/components/ui/button";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import type { ChatThread } from "@/lib/api";
import { cn } from "@/lib/utils";

/** Live Project Chat thread — ACP over WS, user-first welcome, no attach stubs. */
export function ChatThreadView({
  thread,
  showBack,
  railOpen,
  onToggleRail,
  onStreamingSettled,
}: {
  thread: ChatThread | null;
  showBack?: boolean;
  /** Desktop rail visibility (omit on mobile). */
  railOpen?: boolean;
  onToggleRail?: () => void;
  /** Refresh the thread list after a turn (auto-title may have changed). */
  onStreamingSettled?: () => void;
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
          key={thread.id}
          threadId={thread.id}
          welcomeTitle={thread.title.trim() || "New Chat"}
          onStreamingSettled={onStreamingSettled}
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
  threadId,
  welcomeTitle,
  onStreamingSettled,
}: {
  threadId: string;
  welcomeTitle: string;
  onStreamingSettled?: () => void;
}) {
  const chat = useAcpChat({
    threadId,
    onStreamingChange: (streaming) => {
      if (!streaming) onStreamingSettled?.();
    },
  });

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-destructive">Could not start Project Chat</p>
        <p className="max-w-md text-sm text-muted-foreground">{chat.error}</p>
      </div>
    );
  }

  if (chat.status === "connecting") {
    return <ThreadShell showComposerMediaStubs={false} />;
  }

  if (chat.status === "displaced") {
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
      <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4 overflow-y-auto px-4 py-6">
        {messages.length === 0 ? (
          <p className="text-center text-sm text-muted-foreground">
            No messages in this session.
          </p>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={cn(
                "text-sm leading-relaxed",
                m.role === "user" ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {m.role === "user" ? "You" : "Assistant"}
              </p>
              {m.parts.map((part, i) =>
                part.type === "text" ? (
                  <p key={i} className="whitespace-pre-wrap">
                    {part.text}
                  </p>
                ) : null,
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
