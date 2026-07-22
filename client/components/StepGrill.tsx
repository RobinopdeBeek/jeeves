import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  makeAssistantDataUI,
} from "@assistant-ui/react";
import { IconLoader2, IconPaperclip, IconSend } from "@tabler/icons-react";
import type { UIMessage } from "ai";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  type PermissionRequestData,
  type AcpChatTransport,
} from "@/hooks/acp-chat-transport";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import { api } from "@/lib/api";
import type { StepPanelProps } from "./step-panel-types";

const TransportContext = createContext<AcpChatTransport | null>(null);

/** Grill tab — assistant-ui thread + composer over AcpBridge WebSocket. */
export function StepGrill({ card }: StepPanelProps) {
  const chat = useAcpChat({ cardId: card.id, stepKey: "grill", round: 0 });

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
        <p className="text-destructive">Could not start grill session</p>
        <p className="max-w-md text-sm text-muted-foreground">{chat.error}</p>
      </div>
    );
  }

  if (chat.status === "connecting") {
    return <GrillThreadShell />;
  }

  if (chat.status === "displaced") {
    return (
      <DisplacedGrill
        cardId={card.id}
        reason={chat.reason}
        fallbackMessages={chat.messages}
      />
    );
  }

  return (
    <AcpChatProvider transport={chat.transport} messages={chat.messages}>
      <TransportContext.Provider value={chat.transport}>
        <PermissionDataUI />
        <GrillThread sessionOpen={chat.sessionOpen} />
      </TransportContext.Provider>
    </AcpChatProvider>
  );
}

/** Registers a renderer for AI SDK `data-permission` parts. */
const PermissionDataUI = makeAssistantDataUI<PermissionRequestData>({
  name: "permission",
  render: ({ data }) => <PermissionPartView data={data} />,
});

/** Thread chrome while waiting for transcript `ready` (usually <100ms). */
function GrillThreadShell() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-muted-foreground">Loading conversation…</p>
      </div>
      <div className="flex items-end gap-2 border-t p-3">
        <Button variant="ghost" size="icon-sm" disabled title="Attach files">
          <IconPaperclip />
        </Button>
        <div className="flex flex-1 items-end gap-2">
          <textarea
            rows={1}
            disabled
            placeholder="Loading…"
            className="min-h-9 flex-1 resize-none opacity-50"
          />
          <Button size="icon-sm" disabled title="Starting session…">
            <IconLoader2 className="animate-spin" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Displaced writer: banner + latest transcript from the artifact API.
 * Composer is omitted (read-only). Message list is plain replay — no live
 * assistant-ui runtime, matching the frozen/read-only Grill path.
 */
function DisplacedGrill({
  cardId,
  reason,
  fallbackMessages,
}: {
  cardId: string;
  reason: string;
  fallbackMessages: UIMessage[];
}) {
  const [messages, setMessages] = useState<UIMessage[]>(fallbackMessages);
  const banner =
    reason === "session continued elsewhere"
      ? "Session continued elsewhere"
      : reason;

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const artifact = await api.getLatestArtifact(cardId, {
          stepKey: "grill",
          round: 0,
          kind: "transcript",
        });
        const parsed = JSON.parse(artifact.content) as UIMessage[];
        if (!cancelled && Array.isArray(parsed)) setMessages(parsed);
      } catch {
        // Keep socket fallback if the artifact isn't readable yet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      <div
        className="border-b bg-muted px-4 py-2 text-center text-sm text-muted-foreground"
        role="status"
      >
        {banner}
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 ? (
          <p className="text-muted-foreground">No transcript yet.</p>
        ) : (
          messages.map((message) => (
            <ReadOnlyMessage key={message.id} message={message} />
          ))
        )}
      </div>
    </div>
  );
}

function ReadOnlyMessage({ message }: { message: UIMessage }) {
  const align = message.role === "user" ? "justify-end" : "justify-start";
  return (
    <div className={`flex ${align}`}>
      <div className="max-w-[85%] space-y-2">
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <p key={i} className="whitespace-pre-wrap text-sm">
                {part.text}
              </p>
            );
          }
          if (part.type === "data-permission") {
            return (
              <PermissionPartView
                key={i}
                data={(part as { data: PermissionRequestData }).data}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}

function GrillThread({ sessionOpen }: { sessionOpen: boolean }) {
  return (
    <ThreadPrimitive.Root className="flex flex-1 flex-col overflow-hidden">
      <ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <AuiIf condition={(s) => s.thread.isEmpty}>
          <p className="text-muted-foreground">
            {sessionOpen ? "Waiting for the agent…" : "Starting agent session…"}
          </p>
        </AuiIf>

        <ThreadPrimitive.Messages>
          {({ message }) =>
            message.role === "user" ? <UserMessage /> : <AssistantMessage />
          }
        </ThreadPrimitive.Messages>
      </ThreadPrimitive.Viewport>

      <GrillComposer sessionOpen={sessionOpen} />
    </ThreadPrimitive.Root>
  );
}

function GrillComposer({ sessionOpen }: { sessionOpen: boolean }) {
  return (
    <div className="flex items-end gap-2 border-t p-3">
      <Button variant="ghost" size="icon-sm" disabled title="Attach files">
        <IconPaperclip />
      </Button>
      <ComposerPrimitive.Root className="flex flex-1 items-end gap-2">
        <ComposerPrimitive.Input
          rows={1}
          placeholder={sessionOpen ? "Message…" : "Agent starting — you can type…"}
          className="min-h-9 flex-1 resize-none"
        />
        {sessionOpen ? (
          <ComposerPrimitive.Send asChild>
            <Button size="icon-sm" title="Send">
              <IconSend />
            </Button>
          </ComposerPrimitive.Send>
        ) : (
          <Button size="icon-sm" disabled title="Starting session…">
            <IconLoader2 className="animate-spin" />
          </Button>
        )}
      </ComposerPrimitive.Root>
    </div>
  );
}

function UserMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-end">
      <div className="max-w-[85%]">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage() {
  return (
    <MessagePrimitive.Root className="flex justify-start">
      <div className="max-w-[85%] space-y-2">
        <MessagePrimitive.Parts />
      </div>
    </MessagePrimitive.Root>
  );
}

function PermissionPartView({ data }: { data: PermissionRequestData }) {
  const transport = useContext(TransportContext);
  const pending = data.status === "pending" && !!transport;

  const selectedLabel = useMemo(() => {
    if (!data.selectedOptionId) return null;
    return (
      data.options.find((o) => o.optionId === data.selectedOptionId)?.name ??
      data.selectedOptionId
    );
  }, [data.options, data.selectedOptionId]);

  return (
    <div className="space-y-2 rounded-md border p-3 text-sm">
      <p className="font-medium">{data.title ?? "Permission required"}</p>
      {data.status === "resolved" ? (
        <p className="text-muted-foreground">
          {selectedLabel ? `Selected: ${selectedLabel}` : "Resolved"}
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {data.options.map((option) => (
            <Button
              key={option.optionId}
              size="sm"
              variant={option.kind.startsWith("allow") ? "default" : "outline"}
              disabled={!pending}
              onClick={() =>
                transport?.respondToPermission(data.requestId, option.optionId)
              }
            >
              {option.name}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}
