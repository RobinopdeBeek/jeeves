import {
  IconArrowLeft,
  IconLayoutSidebar,
  IconLayoutSidebarFilled,
} from "@tabler/icons-react";
import { Link } from "react-router-dom";
import { Thread, ThreadShell } from "@/components/assistant-ui/thread";
import { ChatModelPicker } from "@/components/chat/ChatModelPicker";
import { ReconnectingBanner } from "@/components/chat/ReconnectingBanner";
import { SessionErrorBanner } from "@/components/chat/SessionErrorBanner";
import { FrozenTranscriptView } from "@/components/grill/ReadOnlyTranscript";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { GrillTransportContext } from "@/components/grill/transport-context";
import { Button } from "@/components/ui/button";
import { AcpChatProvider } from "@/hooks/useAcpChat";
import {
  truncateOpForEdit,
  useProjectChatThreadSession,
} from "@/hooks/useProjectChatThreadSession";
import type { ChatThread } from "@/lib/api";
import type { UIMessage } from "ai";

/** Live Project Chat thread — ACP over WS, user-first welcome, model picker. */
export function ChatThreadView({
  thread,
  showBack,
  railOpen,
  onToggleRail,
  onStreamingChange,
  onStreamingSettled,
  onThreadUpdated,
}: {
  thread: ChatThread | null;
  showBack?: boolean;
  /** Desktop rail visibility (omit on mobile). */
  railOpen?: boolean;
  onToggleRail?: () => void;
  /** Active-thread busy for the chat rail. */
  onStreamingChange?: (streaming: boolean) => void;
  /** Refresh the thread list after a turn (auto-title may have changed). */
  onStreamingSettled?: () => void;
  /** Keep parent list/active row in sync when the pinned model changes. */
  onThreadUpdated?: (thread: ChatThread) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
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
          // Model changes switch in place now, so only the thread is identity.
          key={thread.id}
          thread={thread}
          welcomeTitle={thread.title.trim() || "New Chat"}
          onStreamingChange={onStreamingChange}
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
  onStreamingChange,
  onStreamingSettled,
  onThreadUpdated,
}: {
  thread: ChatThread;
  welcomeTitle: string;
  onStreamingChange?: (streaming: boolean) => void;
  onStreamingSettled?: () => void;
  onThreadUpdated?: (thread: ChatThread) => void;
}) {
  const session = useProjectChatThreadSession({
    thread,
    onStreamingChange,
    onStreamingSettled,
    onThreadUpdated,
  });
  const { chat } = session;

  const modelPicker = (
    <ChatModelPicker
      model={thread.model}
      onModelChange={session.handleModelChange}
      disabled={session.rewinding}
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

  if (chat.status === "displaced") {
    return (
      <DisplacedProjectChat reason={chat.reason} messages={chat.messages} />
    );
  }

  if (session.rewinding || !chat.historyReady) {
    return <ThreadShell composerLeading={modelPicker} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {chat.connection === "reconnecting" ? <ReconnectingBanner /> : null}
      {chat.sessionError ? (
        <SessionErrorBanner error={chat.sessionError} />
      ) : null}
      <AcpChatProvider
        key={String(chat.epoch)}
        transport={chat.transport}
        messages={chat.messages}
        promptCapabilities={chat.promptCapabilities}
        autoSendText={session.pendingSend?.text ?? null}
        autoSendKey={session.pendingSend?.key ?? null}
        sessionOpen={chat.sessionOpen}
        onAutoSendConsumed={session.clearPendingSend}
      >
        <GrillTransportContext.Provider value={chat.transport}>
          <PermissionDataUI />
          <Thread
            welcomeTitle={welcomeTitle}
            attachmentsEnabled={chat.attachmentsEnabled}
            composerLeading={modelPicker}
            rewind={{
              branchable: session.branchable,
              onSwitchBranch: (id) => session.branchAdapter.switchToBranch(id),
              onEditMessage: (messageId, text) => {
                void session.runRewind(
                  truncateOpForEdit(session.branchable, messageId),
                  text,
                );
              },
              disabled: session.rewindDisabled,
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
