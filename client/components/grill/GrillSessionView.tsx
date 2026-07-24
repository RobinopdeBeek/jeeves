import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { MarkdownBody } from "@/components/MarkdownBody";
import { ScrollArea } from "@/components/ui/scroll-area";

/** Done Grill tab: durable Grill session Q&A markdown (not the raw transcript). */
export function GrillSessionView({ cardId }: { cardId: string }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const artifact = await api.getLatestArtifact(cardId, {
          stepKey: "grill",
          round: 0,
          kind: "grill",
        });
        if (!cancelled) {
          setContent(artifact.content);
          setError(null);
        }
      } catch {
        if (!cancelled) {
          setContent(null);
          setError("No Grill session artifact yet.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cardId]);

  return (
    <ScrollArea
      className="min-h-0 flex-1 bg-background"
      style={{
        ["--thread-max-width" as string]: "44rem",
      }}
    >
      <div className="mx-auto w-full max-w-(--thread-max-width) px-4 py-4">
        {error ? (
          <p className="text-sm text-muted-foreground">{error}</p>
        ) : content === null ? (
          <p className="text-sm text-muted-foreground">Loading Grill session…</p>
        ) : (
          <MarkdownBody>{content}</MarkdownBody>
        )}
      </div>
    </ScrollArea>
  );
}
