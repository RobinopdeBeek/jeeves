import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ChatThreadList } from "@/components/chat/ChatThreadList";
import { ChatThreadView } from "@/components/chat/ChatThreadView";
import { useIsMd } from "@/hooks/use-is-md";
import { api, type ChatThread } from "@/lib/api";
import { mergeBusyFromList } from "@/lib/chat-thread-rail";
import { resolveBareChatDestination } from "@/lib/chat-routes";
import { toast } from "@/components/ui/sonner";

/** Poll while any thread is busy so the rail can clear spinners / set unread. */
const BUSY_POLL_MS = 1500;

/** Project Chat — thread rail / mobile list + live ACP thread view. */
export function ChatPage() {
  const { threadId } = useParams<{ threadId?: string }>();
  const navigate = useNavigate();
  const isDesktop = useIsMd();
  const [threads, setThreads] = useState<ChatThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [active, setActive] = useState<ChatThread | null>(null);
  const [railOpen, setRailOpen] = useState(true);
  const [busyIds, setBusyIds] = useState<Set<string>>(() => new Set());
  const [unreadIds, setUnreadIds] = useState<Set<string>>(() => new Set());
  const threadIdRef = useRef(threadId);
  threadIdRef.current = threadId;

  const applyListBusy = useCallback((listed: ChatThread[]) => {
    setBusyIds((prev) => {
      const { busy, settled } = mergeBusyFromList(
        prev,
        listed,
        threadIdRef.current,
      );
      if (settled.length > 0) {
        const activeId = threadIdRef.current;
        setUnreadIds((uPrev) => {
          const next = new Set(uPrev);
          for (const id of settled) {
            if (id !== activeId) next.add(id);
          }
          return next;
        });
      }
      return busy;
    });
  }, []);

  const refresh = useCallback(async () => {
    const listed = await api.listChatThreads();
    setThreads(listed);
    applyListBusy(listed);
    return listed;
  }, [applyListBusy]);

  const refreshActiveTitle = useCallback(async () => {
    const listed = await refresh();
    if (!threadId) return;
    const fromList = listed.find((t) => t.id === threadId);
    if (fromList) setActive(fromList);
  }, [refresh, threadId]);

  useEffect(() => {
    if (!threadId) return;
    setUnreadIds((prev) => {
      if (!prev.has(threadId)) return prev;
      const next = new Set(prev);
      next.delete(threadId);
      return next;
    });
  }, [threadId]);

  useEffect(() => {
    if (busyIds.size === 0) return;
    const timer = setInterval(() => {
      void refresh().catch(() => {
        /* non-fatal — rail indicators catch up on next successful poll */
      });
    }, BUSY_POLL_MS);
    return () => clearInterval(timer);
  }, [busyIds.size, refresh]);

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

  function handleActiveStreamingChange(streaming: boolean) {
    if (!threadId) return;
    setBusyIds((prev) => {
      const next = new Set(prev);
      if (streaming) next.add(threadId);
      else next.delete(threadId);
      return next;
    });
    if (!streaming) {
      setUnreadIds((prev) => {
        if (!prev.has(threadId)) return prev;
        const next = new Set(prev);
        next.delete(threadId);
        return next;
      });
    }
  }

  async function handleNewThread() {
    try {
      const thread = await api.createChatThread();
      // Splice locally so navigation is not blocked on a full list refetch.
      // Server may reuse an existing empty "New Chat" draft — update in place.
      setThreads((prev) => {
        const idx = prev.findIndex((t) => t.id === thread.id);
        if (idx >= 0) {
          const next = [...prev];
          next.splice(idx, 1);
          return [thread, ...next];
        }
        return [thread, ...prev];
      });
      navigate(`/chat/${thread.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not create thread");
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

  function handleThreadUpdated(updated: ChatThread) {
    setThreads((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
    if (active?.id === updated.id) setActive(updated);
  }

  async function handleDelete(id: string) {
    try {
      await api.deleteChatThread(id);
      setBusyIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setUnreadIds((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
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
            busyIds={busyIds}
            unreadIds={unreadIds}
            onNewThread={handleNewThread}
            onRename={handleRename}
            onDelete={handleDelete}
            creating={false}
          />
        </div>
      );
    }
    return (
      <ChatThreadView
        thread={active}
        showBack
        onStreamingChange={handleActiveStreamingChange}
        onStreamingSettled={() => {
          void refreshActiveTitle();
        }}
        onThreadUpdated={handleThreadUpdated}
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
            busyIds={busyIds}
            unreadIds={unreadIds}
            onNewThread={handleNewThread}
            onRename={handleRename}
            onDelete={handleDelete}
            creating={false}
          />
        </aside>
      ) : null}
      <ChatThreadView
        thread={active}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((open) => !open)}
        onStreamingChange={handleActiveStreamingChange}
        onStreamingSettled={() => {
          void refreshActiveTitle();
        }}
        onThreadUpdated={handleThreadUpdated}
      />
    </div>
  );
}
