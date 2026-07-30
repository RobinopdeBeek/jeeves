import {
  IconArrowBackUp,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react";
import { nanoid } from "nanoid";
import { useEffect, useRef, useState } from "react";
import {
  AssistLauncherFab,
  DefineAssistChat,
  DefineAssistSidePanel,
  initialAssistOpen,
  TASKS_ASSIST_LABELS,
} from "@/components/assist/DefineAssistPanel";
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
import { useTasksTipSession } from "@/hooks/useTasksTipSession";
import type { TasksDraftTask, TasksDraftTip } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { StepPanelProps } from "./step-panel-types";

type InspectorState =
  | { mode: "edit"; taskId: string }
  | { mode: "add"; draft: TasksDraftTask }
  | null;

/**
 * Tasks shaping surface: tip `tasks-draft` tiles + inspector + AI side-chat
 * (ADR 0014). Tip protocol lives in useTasksTipSession; assist chrome is shared.
 */
export function StepTasks({
  card,
  onCardChange,
  registerTasksFooter,
}: StepPanelProps) {
  const tasksStep = card.steps.find((s) => s.key === "tasks");
  // Match Spec: keep assist mounted while the step is ai-working (turn in
  // flight). Gating on needs-user alone unmounts the panel on every send.
  const shaping =
    tasksStep?.status === "needs-user" || tasksStep?.status === "ai-working";
  const editable = tasksStep?.status === "needs-user";
  const awaiting = tasksStep?.status === "awaiting";
  const children = card.children ?? [];
  const progress = card.implementProgress;

  const [streaming, setStreaming] = useState(false);
  const [displaced, setDisplaced] = useState(false);
  const [assistOpen, setAssistOpen] = useState(initialAssistOpen);
  const [assistUnread, setAssistUnread] = useState(false);
  const [inspector, setInspector] = useState<InspectorState>(null);
  const [form, setForm] = useState({
    title: "",
    description: "",
    dependsOn: [] as string[],
  });

  const tip = useTasksTipSession({
    cardId: card.id,
    editable,
    streaming,
    displaced,
    onCardChange,
  });

  const assistOpenRef = useRef(assistOpen);
  assistOpenRef.current = assistOpen;
  const wasStreamingRef = useRef(false);
  const implementRef = useRef(tip.implement);
  implementRef.current = tip.implement;

  useEffect(() => {
    if (!registerTasksFooter) return;
    if (!shaping) {
      registerTasksFooter(null);
      return;
    }
    registerTasksFooter({
      canImplement: tip.canImplement,
      implementing: tip.implementing,
      error: tip.actionError,
      implement: () => {
        void implementRef.current();
      },
    });
  }, [
    registerTasksFooter,
    shaping,
    tip.canImplement,
    tip.implementing,
    tip.actionError,
  ]);

  useEffect(() => {
    return () => registerTasksFooter?.(null);
  }, [registerTasksFooter]);

  function applyRevision(draft: TasksDraftTip) {
    tip.applyRevision(draft);
    setInspector(null);
  }

  function setAssistStreaming(next: boolean) {
    if (!next && wasStreamingRef.current && !assistOpenRef.current) {
      setAssistUnread(true);
    }
    const turnEnded = wasStreamingRef.current && !next;
    wasStreamingRef.current = next;
    setStreaming(next);
    if (turnEnded) void tip.refreshTipFromArtifact();
  }

  function openEdit(task: TasksDraftTask) {
    if (tip.mutationsLocked) return;
    tip.setActionError(null);
    setInspector({ mode: "edit", taskId: task.id });
    setForm({
      title: task.title,
      description: task.description,
      dependsOn: [...task.dependsOn],
    });
  }

  function openAdd() {
    if (tip.mutationsLocked) return;
    tip.setActionError(null);
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
    if (!inspector || tip.mutationsLocked) return;
    const title = form.title.trim();
    if (!title) {
      tip.setActionError("Title is required");
      return;
    }
    const task: TasksDraftTask = {
      id: inspector.mode === "add" ? inspector.draft.id : inspector.taskId,
      title,
      description: form.description,
      dependsOn: form.dependsOn,
    };
    const tasks =
      inspector.mode === "add"
        ? [...tip.tip.tasks, task]
        : tip.tip.tasks.map((t) => (t.id === task.id ? task : t));
    const saved = await tip.saveTasks(tasks);
    if (saved) closeInspector();
  }

  async function deleteTask(taskId: string) {
    const saved = await tip.deleteTask(taskId);
    if (saved && inspector?.mode === "edit" && inspector.taskId === taskId) {
      closeInspector();
    }
  }

  /** Compact cue for draft tiles: "Blocked by 1 and 2". */
  function formatBlockedByNumbers(dependsOn: string[]): string {
    const nums = dependsOn
      .map((id) => tip.tip.tasks.findIndex((t) => t.id === id))
      .filter((i) => i >= 0)
      .map((i) => String(i + 1));
    if (nums.length === 0) return "";
    if (nums.length === 1) return `Blocked by ${nums[0]}`;
    if (nums.length === 2) return `Blocked by ${nums[0]} and ${nums[1]}`;
    return `Blocked by ${nums.slice(0, -1).join(", ")}, and ${nums[nums.length - 1]}`;
  }

  function toggleDepend(id: string) {
    setForm((prev) => ({
      ...prev,
      dependsOn: prev.dependsOn.includes(id)
        ? prev.dependsOn.filter((d) => d !== id)
        : [...prev.dependsOn, id],
    }));
  }

  if (!tip.loaded) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-muted-foreground">Loading Tasks…</p>
      </div>
    );
  }

  if (tip.loadError) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-sm text-destructive" role="alert">
          {tip.loadError}
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
  const blockerCandidates = tip.tip.tasks
    .map((t, index) => ({ task: t, index }))
    .filter(({ task }) => task.id !== editingId);

  function openAssist() {
    setAssistOpen(true);
    setAssistUnread(false);
  }

  function closeAssist() {
    setAssistOpen(false);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {tip.actionError && !shaping ? (
        <p className="text-sm text-destructive" role="alert">
          {tip.actionError}
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
          "relative flex min-h-0 flex-1 flex-col",
          // Keep the row while the panel exit-animates; panel is always mounted.
          shaping && "md:flex-row md:gap-4",
        )}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3">
          {shaping ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={openAdd}
                disabled={tip.mutationsLocked}
              >
                <IconPlus data-icon="inline-start" />
                Add task
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void tip.undo()}
                disabled={tip.mutationsLocked || tip.versionCount < 2}
                aria-label="Undo"
              >
                <IconArrowBackUp data-icon="inline-start" />
                Undo
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
          ) : tip.tip.tasks.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center">
              <p className="text-muted-foreground">
                {editable
                  ? "No draft tasks yet. Add one to start shaping the breakdown."
                  : "No draft tasks."}
              </p>
            </div>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
              {tip.tip.tasks.map((task, index) => (
                <li key={task.id}>
                  <div className="group relative">
                    <button
                      type="button"
                      className={cn(cardTileVariants({ attention: false }), "w-full")}
                      onClick={() => openEdit(task)}
                      disabled={tip.mutationsLocked}
                    >
                      <div className="text-sm font-medium">
                        {index + 1}.{" "}
                        {task.title || (
                          <em className="text-muted-foreground">Untitled task</em>
                        )}
                      </div>
                      {task.dependsOn.length > 0 ? (
                        <div className="mt-1 truncate text-xs font-medium text-foreground/60">
                          {formatBlockedByNumbers(task.dependsOn)}
                        </div>
                      ) : null}
                      {task.description ? (
                        <div className="mt-1 truncate text-xs text-muted-foreground">
                          {task.description}
                        </div>
                      ) : null}
                    </button>
                    {shaping ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                        aria-label={`Delete ${task.title || "task"}`}
                        disabled={tip.mutationsLocked}
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
        </div>

        {shaping ? (
          <TooltipProvider>
            {!assistOpen ? (
              <AssistLauncherFab
                panelId="tasks-assist-panel"
                labels={TASKS_ASSIST_LABELS}
                streaming={streaming}
                unread={assistUnread}
                onExpand={openAssist}
              />
            ) : null}
            <DefineAssistSidePanel
              panelId="tasks-assist-panel"
              labels={TASKS_ASSIST_LABELS}
              open={assistOpen}
              streaming={streaming}
              onClose={closeAssist}
            >
              <DefineAssistChat
                cardId={card.id}
                stepKey="tasks"
                labels={TASKS_ASSIST_LABELS}
                getLiveDraftBody={tip.liveDraftBody}
                onTasksRevised={applyRevision}
                onStreamingChange={setAssistStreaming}
                onDisplaced={() => setDisplaced(true)}
                composerLocked={streaming}
              />
            </DefineAssistSidePanel>
          </TooltipProvider>
        ) : null}
      </div>

      <Dialog
        open={inspector !== null}
        onOpenChange={(open) => {
          if (!open) closeInspector();
        }}
      >
        <DialogContent
          className="flex max-h-[calc(100dvh-2rem)] flex-col gap-4 overflow-hidden sm:max-w-lg"
          showCloseButton={false}
        >
          <DialogHeader className="shrink-0">
            <DialogTitle>
              {inspector?.mode === "add" ? "New task" : "Edit task"}
            </DialogTitle>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Title</span>
              <Input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Vertical slice title"
                disabled={!editable || tip.busy || streaming}
                autoFocus
              />
            </label>

            <div className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Blocked by</span>
              {blockerCandidates.length === 0 ? (
                <p className="text-xs text-muted-foreground">No other drafts yet.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {blockerCandidates.map(({ task: t, index }) => {
                    const selected = form.dependsOn.includes(t.id);
                    return (
                      <Button
                        key={t.id}
                        type="button"
                        size="sm"
                        variant={selected ? "default" : "outline"}
                        disabled={!editable || tip.busy || streaming}
                        onClick={() => toggleDepend(t.id)}
                      >
                        {index + 1}. {t.title || "Untitled"}
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
                disabled={!editable || tip.busy || streaming}
              />
            </label>
          </div>

          <DialogFooter className="shrink-0">
            {editable && inspector?.mode === "edit" ? (
              <Button
                type="button"
                variant="ghost"
                className="sm:mr-auto"
                disabled={tip.busy || streaming}
                onClick={() => void deleteTask(inspector.taskId)}
              >
                <IconTrash data-icon="inline-start" />
                Delete
              </Button>
            ) : null}
            <Button
              type="button"
              variant="outline"
              disabled={tip.busy}
              onClick={closeInspector}
            >
              {editable ? "Discard" : "Close"}
            </Button>
            {editable ? (
              <Button
                type="button"
                disabled={tip.busy || streaming}
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
