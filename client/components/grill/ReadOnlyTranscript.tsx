import type { UIMessage } from "ai";
import { useEffect, useState } from "react";
import type { PermissionRequestData } from "@/hooks/acp-chat-transport";
import { api } from "@/lib/api";
import { PermissionPartView } from "./PermissionPartView";

/** Frozen / displaced grill transcript from the artifact API (no live ACP). */
export function ReadOnlyTranscript({
  cardId,
  fallbackMessages,
}: {
  cardId: string;
  fallbackMessages: UIMessage[];
}) {
  const [messages, setMessages] = useState<UIMessage[]>(fallbackMessages);

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
    <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
      {messages.length === 0 ? (
        <p className="text-muted-foreground">No transcript yet.</p>
      ) : (
        messages.map((message) => (
          <ReadOnlyMessage key={message.id} message={message} />
        ))
      )}
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
