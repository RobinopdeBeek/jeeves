import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChatThreadList } from "@/components/chat/ChatThreadList";
import { ChatThreadView } from "@/components/chat/ChatThreadView";
import { useIsMd } from "@/hooks/use-is-md";
import { api, type ChatThread } from "@/lib/api";
import { resolveBareChatDestination } from "@/lib/chat-routes";
import { toast } from "sonner";

/** Project Chat — thread rail / mobile list + live ACP thread view. */
export function ChatPage() {
  const { threadId } = useParams<{ threadId?: string }>();
  const navigate = useNavigate();
  const isDesktop = useIsMd();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [active, setActive] = useState<ChatThread | null>(null);
  const [railOpen, setRailOpen] = useState(true);

  const refresh = useCallback(async () => {
    const listed = await api.listChatThreads();
    setThreads(listed);
    return listed;
  }, []);

  const refreshActiveTitle = useCallback(async () => {
    const listed = await refresh();
    if (!threadId) return;
    const fromList = listed.find((t) => t.id === threadId);
    if (fromList) setActive(fromList);
  }, [refresh, threadId]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const listed = await refresh();
        if (cancelled) return;

        if (!threadId) {
          let lastOpenedId: string | null = null;
          try {
            lastOpenedId = (await api.getLastOpenedChatThread()).id;
          } catch {
            lastOpenedId = null;
          }
          const dest = resolveBareChatDestination(isDesktop, lastOpenedId);
          if (dest.kind === "thread") {
            navigate(`/chat/${dest.threadId}`, { replace: true });
            return;
          }
          setActive(null);
          return;
        }

        const fromList = listed.find((t) => t.id === threadId);
        if (fromList) {
          setActive(fromList);
          void api.openChatThread(threadId).catch(() => {
            /* non-fatal — list still works */
          });
          return;
        }
        try {
          const thread = await api.getChatThread(threadId);
          setActive(thread);
          void api.openChatThread(threadId).catch(() => {});
        } catch {
          toast.error("Thread not found");
          navigate("/chat", { replace: true });
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load threads");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [threadId, isDesktop, navigate, refresh]);

  async function handleNewThread() {
    setCreating(true);
    try {
      const thread = await api.createChatThread();
      await refresh();
      navigate(`/chat/${thread.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create thread");
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(id: string, title: string) {
    try {
      const updated = await api.renameChatThread(id, title);
      setThreads((prev) => prev.map((t) => (t.id === id ? updated : t)));
      if (active?.id === id) setActive(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rename thread");
    }
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteChatThread(id);
      const listed = await refresh();
      if (threadId === id) {
        if (isDesktop && listed[0]) {
          navigate(`/chat/${listed[0].id}`, { replace: true });
        } else {
          navigate("/chat", { replace: true });
          setActive(null);
        }
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete thread");
    }
  }

  if (loading) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
        Loading threads…
      </div>
    );
  }

  // Mobile: `/chat` is the list; `/chat/:threadId` is the conversation.
  if (!isDesktop) {
    if (!threadId) {
      return (
        <div className="flex min-h-0 flex-1 flex-col">
          <ChatThreadList
            threads={threads}
            onNewThread={handleNewThread}
            onRename={handleRename}
            onDelete={handleDelete}
            creating={creating}
          />
        </div>
      );
    }
    return (
      <ChatThreadView
        thread={active}
        showBack
        onStreamingSettled={() => {
          void refreshActiveTitle();
        }}
      />
    );
  }

  // Desktop: persistent rail + live thread (rail toggle in thread chrome).
  return (
    <div className="flex min-h-0 flex-1">
      {railOpen ? (
        <aside className="flex w-64 shrink-0 flex-col border-r">
          <ChatThreadList
            threads={threads}
            activeId={threadId}
            onNewThread={handleNewThread}
            onRename={handleRename}
            onDelete={handleDelete}
            creating={creating}
          />
        </aside>
      ) : null}
      <ChatThreadView
        thread={active}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((open) => !open)}
        onStreamingSettled={() => {
          void refreshActiveTitle();
        }}
      />
    </div>
  );
}
