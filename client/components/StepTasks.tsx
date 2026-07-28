import {
  IconArrowBackUp,
  IconArrowForwardUp,
  IconLayoutSidebarRightCollapse,
  IconLoader2,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import type { UIMessage } from "ai";
import { Thread, ThreadShell } from "@/components/assistant-ui/thread";
import { AcpChatProvider, useAcpChat } from "@/hooks/useAcpChat";
import { ReconnectingBanner } from "@/components/chat/ReconnectingBanner";
import { PermissionDataUI } from "@/components/grill/PermissionPartView";
import { ReadOnlyTranscript } from "@/components/grill/ReadOnlyTranscript";
import { GrillTransportContext } from "@/components/grill/transport-context";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { cardTileVariants } from "@/components/ui/pipeline-status";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { api, type TasksDraft, type TasksDraftTask } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { StepPanelProps } from "./step-panel-types";

type InspectorState =
  | { mode: "edit"; taskId: string }
  | { mode: "add"; draft: TasksDraftTask }
  | null;

/**
 * Tasks shaping surface: tip `tasks-draft` tiles + inspector + AI side-chat
 * (ADR 0014; Spec-assist twin for revise / Q&A).
 */
export function StepTasks({ card, onCardChange }: StepPanelProps) {
  const tasksStep = card.steps.find((s) => s.key === "tasks");
  const editable = tasksStep?.status === "needs-user";
  const awaiting = tasksStep?.status === "awaiting";
  const children = card.children ?? [];
  const progress = card.implementProgress;

  const [tip, setTip] = useState<TasksDraft>({ tasks: [] });
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [displaced, setDisplaced] = useState(false);
  const [assistOpen, setAssistOpen] = useState(true);
  const [assistUnread, setAssistUnread] = useState(false);
  const [versionCount, setVersionCount] = useState(0);
  const [redoStack, setRedoStack] = useState<TasksDraft[]>([]);
  const [inspector, setInspector] = useState<InspectorState>(null);
  const [implementing, setImplementing] = useState(false);
  const [form, setForm] = useState({
    title: "",
    description: "",
    dependsOn: [] as string[],
  });

  const tipRef = useRef(tip);
  tipRef.current = tip;
  const assistOpenRef = useRef(assistOpen);
  assistOpenRef.current = assistOpen;
  const wasStreamingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    setLoadError(null);
    setRedoStack([]);
    setVersionCount(0);

    void (async () => {
      try {
        const draft = await api.getTasksDraft(card.id);
        if (cancelled) return;
        setTip({ tasks: draft.tasks });
        setVersionCount(draft.versionCount ?? 0);
        setLoaded(true);
      } catch (err) {
        if (!cancelled) {
          setLoadError(err instanceof Error ? err.message : String(err));
          setLoaded(true);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [card.id]);

  const mutationsLocked = !editable || busy || streaming || displaced;

  function applyRevision(draft: TasksDraft) {
    setTip({ tasks: draft.tasks });
    if (draft.versionCount != null) {
      setVersionCount(draft.versionCount);
    } else {
      setVersionCount((c) => c + 1);
    }
    setRedoStack([]);
    setActionError(null);
    setInspector(null);
  }

  async function refreshTipFromArtifact() {
    try {
      const latest = await api.getTasksDraft(card.id);
      const current = tipRef.current;
      const same =
        latest.tasks.length === current.tasks.length &&
        latest.tasks.every(
          (t, i) =>
            t.id === current.tasks[i]?.id &&
            t.title === current.tasks[i]?.title &&
            t.description === current.tasks[i]?.description &&
            JSON.stringify(t.dependsOn) ===
              JSON.stringify(current.tasks[i]?.dependsOn),
        );
      if (same) {
        if (latest.versionCount != null) setVersionCount(latest.versionCount);
        return;
      }
      applyRevision(latest);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    }
  }

  function setAssistStreaming(next: boolean) {
    if (!next && wasStreamingRef.current && !assistOpenRef.current) {
      setAssistUnread(true);
    }
    const turnEnded = wasStreamingRef.current && !next;
    wasStreamingRef.current = next;
    setStreaming(next);
    if (turnEnded) void refreshTipFromArtifact();
  }

  function openEdit(task: TasksDraftTask) {
    if (mutationsLocked) return;
    setActionError(null);
    setInspector({ mode: "edit", taskId: task.id });
    setForm({
      title: task.title,
      description: task.description,
      dependsOn: [...task.dependsOn],
    });
  }

  function openAdd() {
    if (mutationsLocked) return;
    setActionError(null);
    const draft: TasksDraftTask = {
      id: nanoid(10),
      title: "",
      description: "",
      dependsOn: [],
    };
    setInspector({ mode: "add", draft });
    setForm({ title: "", description: "", dependsOn: [] });
  }

  function closeInspector() {
    setInspector(null);
  }

  async function saveInspector() {
    if (!inspector || mutationsLocked) return;
    const title = form.title.trim();
    if (!title) {
      setActionError("Title is required");
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      const task: TasksDraftTask = {
        id: inspector.mode === "add" ? inspector.draft.id : inspector.taskId,
        title,
        description: form.description,
        dependsOn: form.dependsOn,
      };
      const tasks =
        inspector.mode === "add"
          ? [...tip.tasks, task]
          : tip.tasks.map((t) => (t.id === task.id ? task : t));
      const saved = await api.putTasksDraft(card.id, { tasks });
      setTip({ tasks: saved.tasks });
      setVersionCount(saved.versionCount ?? versionCount + 1);
      setRedoStack([]);
      closeInspector();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function deleteTask(taskId: string) {
    if (mutationsLocked) return;
    setBusy(true);
    setActionError(null);
    try {
      const saved = await api.deleteTasksDraftTask(card.id, taskId);
      setTip({ tasks: saved.tasks });
      setVersionCount(saved.versionCount ?? versionCount + 1);
      setRedoStack([]);
      if (inspector?.mode === "edit" && inspector.taskId === taskId) {
        closeInspector();
      }
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function undo() {
    if (mutationsLocked || versionCount < 2) return;
    setBusy(true);
    setActionError(null);
    try {
      const before = tip;
      const next = await api.undoTasksDraft(card.id);
      setTip({ tasks: next.tasks });
      setVersionCount(next.versionCount ?? versionCount + 1);
      setRedoStack((stack) => [...stack, before]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/nothing to undo/i.test(message)) {
        setVersionCount(1);
      } else {
        setActionError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function redo() {
    if (mutationsLocked || redoStack.length === 0) return;
    const next = redoStack[redoStack.length - 1]!;
    setBusy(true);
    setActionError(null);
    try {
      const saved = await api.putTasksDraft(card.id, next);
      setTip({ tasks: saved.tasks });
      setVersionCount(saved.versionCount ?? versionCount + 1);
      setRedoStack((stack) => stack.slice(0, -1));
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function titleById(id: string): string {
    return tip.tasks.find((t) => t.id === id)?.title || id;
  }

  function tipIsValidForImplement(draft: TasksDraft): boolean {
    // Light gate — server fanOut re-validates Zod + DAG. Tip Save already
    // rejects cycles; this only blocks empty/blank titles before the POST.
    return (
      draft.tasks.length >= 1 && draft.tasks.every((t) => t.title.trim().length > 0)
    );
  }

  const canImplement =
    editable && !busy && !streaming && !displaced && tipIsValidForImplement(tip);

  async function implement() {
    if (!canImplement || implementing) return;
    setImplementing(true);
    setActionError(null);
    setInspector(null);
    try {
      const updated = await api.implement(card.id);
      onCardChange(updated);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : String(err));
    } finally {
      setImplementing(false);
    }
  }

  function toggleDepend(id: string) {
    setForm((prev) => ({
      ...prev,
      dependsOn: prev.dependsOn.includes(id)
        ? prev.dependsOn.filter((d) => d !== id)
        : [...prev.dependsOn, id],
    }));
  }

  if (!loaded) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading Tasks…</p>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-destructive" role="alert">
          {loadError}
        </p>
      </div>
    );
  }

  const editingId =
    inspector?.mode === "edit"
      ? inspector.taskId
      : inspector?.mode === "add"
        ? inspector.draft.id
        : null;
  const blockerCandidates = tip.tasks.filter((t) => t.id !== editingId);

  function openAssist() {
    setAssistOpen(true);
    setAssistUnread(false);
  }

  function closeAssist() {
    setAssistOpen(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {actionError ? (
        <p className="text-sm text-destructive" role="alert">
          {actionError}
        </p>
      ) : null}

      {displaced ? (
        <p
          className="border bg-muted px-3 py-2 text-center text-xs text-muted-foreground"
          role="status"
        >
          Session continued elsewhere — tip is read-only here
        </p>
      ) : null}

      <div
        className={cn(
          "relative flex min-h-0 flex-1 flex-col gap-4",
          assistOpen && editable && "md:flex-row",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {editable ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openAdd}
                disabled={mutationsLocked}
              >
                <IconPlus data-icon="inline-start" />
                Add task
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void undo()}
                disabled={mutationsLocked || versionCount < 2}
                aria-label="Undo"
              >
                <IconArrowBackUp data-icon="inline-start" />
                Undo
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void redo()}
                disabled={mutationsLocked || redoStack.length === 0}
                aria-label="Redo"
              >
                <IconArrowForwardUp data-icon="inline-start" />
                Redo
              </Button>
            </div>
          ) : null}

          {awaiting && progress ? (
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <p className="text-sm text-muted-foreground">
                    Implementing Task {progress.current} of {progress.total}
                  </p>
                </TooltipTrigger>
                <TooltipContent>awaiting child tasks</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          ) : null}

          {awaiting ? (
            children.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
                <p className="text-muted-foreground">No child tasks.</p>
              </div>
            ) : (
              <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
                {children.map((child, index) => (
                  <li key={child.id}>
                    <div className={cn(cardTileVariants({ attention: false }), "w-full")}>
                      <div className="text-sm font-medium">
                        {index + 1}. {child.title || (
                          <em className="text-muted-foreground">Untitled</em>
                        )}
                      </div>
                      {child.blockedBy.length > 0 ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Blocked by{" "}
                          {child.blockedBy
                            .map((b) => b.title || "Untitled")
                            .join(", ")}
                        </div>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )
          ) : tip.tasks.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
              <p className="text-muted-foreground">
                {editable
                  ? "No draft tasks yet. Add one to start shaping the breakdown."
                  : "No draft tasks."}
              </p>
            </div>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {tip.tasks.map((task, index) => (
                <li key={task.id}>
                  <div className="group relative">
                    <button
                      type="button"
                      className={cn(cardTileVariants({ attention: false }), "w-full")}
                      onClick={() => openEdit(task)}
                      disabled={mutationsLocked}
                    >
                      <div className="text-sm font-medium">
                        {index + 1}.{" "}
                        {task.title || (
                          <em className="text-muted-foreground">Untitled task</em>
                        )}
                      </div>
                      {task.dependsOn.length > 0 ? (
                        <div className="mt-1 text-xs text-muted-foreground">
                          Blocked by{" "}
                          {task.dependsOn.map(titleById).join(", ")}
                        </div>
                      ) : null}
                      {task.description ? (
                        <div className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                          {task.description}
                        </div>
                      ) : null}
                    </button>
                    {editable ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete ${task.title || "task"}`}
                        disabled={mutationsLocked}
                        onClick={(e) => {
                          e.stopPropagation();
                          void deleteTask(task.id);
                        }}
                      >
                        <IconTrash data-icon="inline-start" />
                      </Button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          )}

          {editable ? (
            <div className="flex justify-end border-t pt-3">
              <Button
                type="button"
                disabled={!canImplement || implementing}
                onClick={() => void implement()}
              >
                {implementing ? (
                  <IconLoader2 data-icon="inline-start" className="animate-spin" />
                ) : null}
                Implement →
              </Button>
            </div>
          ) : null}
        </div>

        {editable ? (
          <TooltipProvider>
            {assistOpen ? (
              <button
                type="button"
                className="absolute inset-0 z-40 bg-foreground/20 md:hidden"
                aria-label="Hide Tasks assist"
                onClick={closeAssist}
              />
            ) : (
              <AssistLauncherFab
                streaming={streaming}
                unread={assistUnread}
                onExpand={openAssist}
              />
            )}
            <aside
              className={cn(
                "flex min-h-40 shrink-0 flex-col overflow-hidden rounded-md border bg-background",
                assistOpen
                  ? "relative z-50 shadow-lg md:static md:z-auto md:w-96 md:shadow-none"
                  : "hidden",
              )}
              aria-label="Tasks assist"
            >
              <div className="flex items-center gap-1 border-b px-2 py-1">
                <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium">
                  Jeeves
                </span>
                {streaming ? (
                  <IconLoader2
                    className="size-3.5 shrink-0 animate-spin text-pipeline-ai"
                    aria-label="Tasks assist is working"
                  />
                ) : null}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-expanded={true}
                      aria-controls="tasks-assist-panel"
                      aria-label="Hide Tasks assist"
                      onClick={closeAssist}
                    >
                      <IconX className="md:hidden" />
                      <IconLayoutSidebarRightCollapse className="hidden md:block" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Hide Tasks assist</TooltipContent>
                </Tooltip>
              </div>
              {/* Keep chat mounted while collapsed so the ACP session stays alive. */}
              <div
                id="tasks-assist-panel"
                className="flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <TasksAssistChat
                  cardId={card.id}
                  getCurrentTasksDraftJson={() =>
                    JSON.stringify({ tasks: tipRef.current.tasks }, null, 2)
                  }
                  onTasksRevised={applyRevision}
                  onStreamingChange={setAssistStreaming}
                  onDisplaced={() => setDisplaced(true)}
                  composerLocked={streaming}
                />
              </div>
            </aside>
          </TooltipProvider>
        ) : null}
      </div>

      <Dialog
        open={inspector !== null}
        onOpenChange={(open) => {
          if (!open) closeInspector();
        }}
      >
        <DialogContent className="sm:max-w-lg" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {inspector?.mode === "add" ? "New task" : "Edit task"}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Title</span>
              <Input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Vertical slice title"
                disabled={!editable || busy || streaming}
                autoFocus
              />
            </label>

            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Blocked by</span>
              {blockerCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">No other drafts yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {blockerCandidates.map((t) => {
                    const selected = form.dependsOn.includes(t.id);
                    return (
                      <Button
                        key={t.id}
                        type="button"
                        size="sm"
                        variant={selected ? "default" : "outline"}
                        disabled={!editable || busy || streaming}
                        onClick={() => toggleDepend(t.id)}
                      >
                        {t.title || "Untitled"}
                        {selected ? <IconX data-icon="inline-end" /> : null}
                      </Button>
                    );
                  })}
                </div>
              )}
            </div>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Description</span>
              <Textarea
                value={form.description}
                onChange={(e) =>
                  setForm((f) => ({ ...f, description: e.target.value }))
                }
                placeholder="Acceptance criteria and file hints…"
                rows={6}
                disabled={!editable || busy || streaming}
              />
            </label>
          </div>

          <DialogFooter>
            {editable && inspector?.mode === "edit" ? (
              <Button
                type="button"
                variant="destructive"
                className="sm:mr-auto"
                disabled={busy || streaming}
                onClick={() => void deleteTask(inspector.taskId)}
              >
                <IconTrash data-icon="inline-start" />
                Delete
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={closeInspector}
            >
              {editable ? "Discard" : "Close"}
            </Button>
            {editable ? (
              <Button
                type="button"
                disabled={busy || streaming}
                onClick={() => void saveInspector()}
              >
                Save
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function AssistLauncherFab({
  streaming,
  unread,
  onExpand,
}: {
  streaming: boolean;
  unread: boolean;
  onExpand: () => void;
}) {
  const statusLabel = streaming
    ? "Tasks assist is working"
    : unread
      ? "New Tasks assist reply"
      : "Show Tasks assist";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="launcher"
          size="icon-launcher"
          onClick={onExpand}
          aria-expanded={false}
          aria-controls="tasks-assist-panel"
          aria-label={statusLabel}
          className="absolute right-3 bottom-3 z-30"
        >
          <Logo className="size-20" />
          {streaming ? (
            <span className="pointer-events-none absolute -top-0.5 -right-0.5 flex size-6 items-center justify-center rounded-full bg-background shadow-sm">
              <IconLoader2
                className="size-4 animate-spin text-pipeline-ai"
                aria-hidden
              />
            </span>
          ) : unread ? (
            <span
              className="pointer-events-none absolute top-1 right-1 size-3 rounded-full bg-pipeline-user ring-2 ring-white"
              aria-hidden
            />
          ) : null}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="left">{statusLabel}</TooltipContent>
    </Tooltip>
  );
}

function TasksAssistChat({
  cardId,
  getCurrentTasksDraftJson,
  onTasksRevised,
  onStreamingChange,
  onDisplaced,
  composerLocked,
}: {
  cardId: string;
  getCurrentTasksDraftJson: () => string;
  onTasksRevised: (draft: TasksDraft) => void;
  onStreamingChange: (streaming: boolean) => void;
  onDisplaced: () => void;
  composerLocked: boolean;
}) {
  const chat = useAcpChat({
    cardId,
    stepKey: "tasks",
    round: 0,
    getCurrentTasksDraftJson,
    onTasksRevised,
    onStreamingChange,
  });

  const displacedNotified = useRef(false);
  useEffect(() => {
    if (chat.status === "displaced" && !displacedNotified.current) {
      displacedNotified.current = true;
      onDisplaced();
    }
  }, [chat.status, onDisplaced]);

  if (chat.status === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-3 text-center">
        <p className="text-sm text-destructive">Could not start Tasks assist</p>
        <p className="text-xs text-muted-foreground">{chat.error}</p>
      </div>
    );
  }

  if (chat.status === "connecting") {
    return <ThreadShell />;
  }

  if (chat.status === "displaced") {
    return (
      <DisplacedTasksAssist
        cardId={cardId}
        reason={chat.reason}
        fallbackMessages={chat.messages}
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
            sessionOpen={chat.sessionOpen && !composerLocked}
            placeholder="Ask or request a change…"
            openingPlaceholder={
              composerLocked
                ? "Tasks assist is working…"
                : "Tasks assist starting…"
            }
          />
        </GrillTransportContext.Provider>
      </AcpChatProvider>
    </div>
  );
}

function DisplacedTasksAssist({
  cardId,
  reason,
  fallbackMessages,
}: {
  cardId: string;
  reason: string;
  fallbackMessages: UIMessage[];
}) {
  const banner =
    reason === "session continued elsewhere"
      ? "Session continued elsewhere"
      : reason;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div
        className="border-b bg-muted px-3 py-2 text-center text-xs text-muted-foreground"
        role="status"
      >
        {banner}
      </div>
      <ReadOnlyTranscript
        cardId={cardId}
        stepKey="tasks"
        fallbackMessages={fallbackMessages}
      />
    </div>
  );
}
