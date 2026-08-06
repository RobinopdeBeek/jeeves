import {
  IconLoader2,
  IconMessage,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import type { ChatThread } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

function threadLabel(thread: ChatThread): string {
  return thread.title.trim() || "New Chat";
}

export function ChatThreadList({
  threads,
  activeId,
  busyIds,
  unreadIds,
  onNewThread,
  onRename,
  onDelete,
  creating,
}: {
  threads: ChatThread[];
  activeId?: string;
  busyIds?: ReadonlySet<string>;
  unreadIds?: ReadonlySet<string>;
  onNewThread: () => void;
  onRename: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  creating?: boolean;
}) {
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renaming = threads.find((t) => t.id === renameId);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <h2 className="text-sm font-medium">Chats</h2>
        <Button
          size="sm"
          onClick={onNewThread}
          disabled={creating}
          aria-label="New Chat"
        >
          <IconPlus data-icon="inline-start" />
          New Chat
        </Button>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto p-2">
        {threads.length === 0 ? (
          <li className="px-2 py-6 text-center text-sm text-muted-foreground">
            No chats yet
          </li>
        ) : (
          threads.map((thread) => {
            const active = thread.id === activeId;
            const label = threadLabel(thread);
            const busy = busyIds?.has(thread.id) ?? false;
            const unread = !busy && (unreadIds?.has(thread.id) ?? false);
            return (
              <li key={thread.id} className="group flex items-center gap-1">
                <Button
                  variant={active ? "secondary" : "ghost"}
                  size="sm"
                  className="min-w-0 flex-1 justify-start"
                  asChild
                >
                  <Link
                    to={`/chat/${thread.id}`}
                    aria-busy={busy || undefined}
                    aria-label={
                      busy
                        ? `${label}, responding`
                        : unread
                          ? `${label}, unread response`
                          : label
                    }
                  >
                    <IconMessage data-icon="inline-start" />
                    <span className="min-w-0 flex-1 truncate text-left">
                      {label}
                    </span>
                    {busy ? (
                      <IconLoader2
                        className="size-3.5 shrink-0 animate-spin text-pipeline-ai"
                        aria-hidden
                      />
                    ) : null}
                    {unread ? (
                      <span
                        className="size-2 shrink-0 rounded-full bg-pipeline-user"
                        aria-hidden
                      />
                    ) : null}
                  </Link>
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                  aria-label={`Rename ${label}`}
                  onClick={() => {
                    setRenameId(thread.id);
                    setRenameValue(thread.title);
                  }}
                >
                  <IconPencil data-icon="inline-start" />
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100"
                      aria-label={`Delete ${label}`}
                    >
                      <IconTrash data-icon="inline-start" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete this thread?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This permanently removes the thread and its transcript.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => {
                          void onDelete(thread.id);
                        }}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </li>
            );
          })
        )}
      </ul>

      <Dialog
        open={renameId !== null}
        onOpenChange={(open) => {
          if (!open) setRenameId(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename thread</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && renameId && renameValue.trim()) {
                void onRename(renameId, renameValue).then(() => setRenameId(null));
              }
            }}
            autoFocus
            aria-label="Thread title"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameId(null)}>
              Cancel
            </Button>
            <Button
              disabled={!renameValue.trim() || !renaming}
              onClick={() => {
                if (!renameId) return;
                void onRename(renameId, renameValue).then(() => setRenameId(null));
              }}
            >
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
