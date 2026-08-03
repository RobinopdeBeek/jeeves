import type { UIMessage } from "ai";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { PermissionRequestData } from "@/hooks/acp-chat-transport";
import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/components/ui/scroll-area";
import { PermissionPartView } from "./PermissionPartView";

/**
 * Replay a frozen UIMessage transcript (displaced / completed chat).
 * Shared by step chats (artifact-backed) and Project Chat (socket fallback).
 */
export function FrozenTranscriptView({
  messages,
}: {
  messages: UIMessage[];
}) {
  return (
    <ScrollArea
      className="min-h-0 flex-1 bg-background"
      style={{
        ["--thread-max-width" as string]: "44rem",
      }}
    >
      <div className="mx-auto flex w-full max-w-(--thread-max-width) flex-col gap-y-6 px-4 py-4">
        {messages.length === 0 ? (
          <p className="text-muted-foreground">No transcript yet.</p>
        ) : (
          messages.map((message) => (
            <ReadOnlyMessage key={message.id} message={message} />
          ))
        )}
      </div>
    </ScrollArea>
  );
}

/** Frozen / displaced chat transcript from the artifact API (no live ACP). */
export function ReadOnlyTranscript({
  cardId,
  stepKey = "grill",
  fallbackMessages,
}: {
  cardId: string;
  stepKey?: "grill" | "spec" | "tasks";
  fallbackMessages: UIMessage[];
}) {
  const [messages, setMessages] = useState<UIMessage[]>(fallbackMessages);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const artifact = await api.getLatestArtifact(cardId, {
          stepKey,
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
  }, [cardId, stepKey]);

  return <FrozenTranscriptView messages={messages} />;
}

function ReadOnlyMessage({ message }: { message: UIMessage }) {
  if (message.role === "user") {
    return (
      <div
        data-slot="aui_user-message-root"
        data-role="user"
        className="grid auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] content-start gap-y-2 px-2 [&:where(>*)]:col-start-2"
      >
        <div className="relative col-start-2 min-w-0">
          <div className="rounded-xl bg-muted px-4 py-2 wrap-break-word text-sm text-foreground empty:hidden">
            {message.parts.map((part, i) => {
              if (part.type !== "text") return null;
              return <span key={i}>{part.text}</span>;
            })}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      data-slot="aui_assistant-message-root"
      data-role="assistant"
      className="relative px-2"
    >
      <div
        className={cn(
          "space-y-2 leading-relaxed wrap-break-word text-foreground",
        )}
      >
        {message.parts.map((part, i) => {
          if (part.type === "text") {
            return (
              <div key={i} className="aui-md text-sm">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {part.text}
                </ReactMarkdown>
              </div>
            );
          }
          if (part.type === "data-permission") {
            return (
              <PermissionPartView
                key={i}
                data={(part as { data: PermissionRequestData }).data}
                interactive={false}
              />
            );
          }
          return null;
        })}
      </div>
    </div>
  );
}
