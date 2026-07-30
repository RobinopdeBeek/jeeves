import { IconArrowLeft, IconLoader2, IconTrash } from "@tabler/icons-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Card, type KindPath } from "@/lib/api";
import { activeTabKey, visibleSteps } from "@/lib/card-steps";
import { useJeevesEvents } from "@/lib/events";
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
import { cn } from "@/lib/utils";
import { Logo } from "./Logo";
import { STEP_PANELS } from "./step-panels";
import type { TasksFooterActions } from "./step-panel-types";

export function CardView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [card, setCard] = useState<Card | null>(null);
  const [missing, setMissing] = useState(false);
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);
  const [creatingSpec, setCreatingSpec] = useState(false);
  const [createSpecError, setCreateSpecError] = useState<string | null>(null);
  const [creatingTasks, setCreatingTasks] = useState(false);
  const [createTasksError, setCreateTasksError] = useState<string | null>(null);
  /** Pessimistic until LiveGrill reports ACP handshake finished. */
  const [grillStarting, setGrillStarting] = useState(true);
  const [tasksFooter, setTasksFooter] = useState<TasksFooterActions | null>(null);
  const flushSpecRef = useRef<(() => Promise<void>) | null>(null);

  const registerSpecFlush = useCallback((flush: (() => Promise<void>) | null) => {
    flushSpecRef.current = flush;
  }, []);

  const registerTasksFooter = useCallback((actions: TasksFooterActions | null) => {
    setTasksFooter(actions);
  }, []);

  const onGrillStartingChange = useCallback((starting: boolean) => {
    setGrillStarting(starting);
  }, []);

  useEffect(() => {
    if (!id) return;
    setTabOverride(null);
    setGrillStarting(true);
    setTasksFooter(null);
    api
      .getCard(id)
      .then(setCard)
      .catch(() => setMissing(true));
  }, [id]);

  useJeevesEvents(
    (event) => {
      if (event.type === "card.updated" && event.card.id === id) {
        setCard(event.card);
      }
    },
    () => {
      if (!id) return;
      api.getCard(id).then(setCard).catch(() => setMissing(true));
    },
  );

  async function remove() {
    if (!card) return;
    await api.deleteCard(card.id);
    navigate("/");
  }

  async function decide(path: KindPath) {
    if (!card || !card.title.trim()) return;
    setDeciding(true);
    try {
      const decided = await api.decideCard(card.id, path);
      setCard(decided);
      setTabOverride(null);
    } catch (err) {
      console.error(err);
    } finally {
      setDeciding(false);
    }
  }

  async function createSpec() {
    if (!card) return;
    setCreatingSpec(true);
    setCreateSpecError(null);
    setTabOverride("grill"); // stay on Grill while synthesis runs
    try {
      const updated = await api.createSpec(card.id);
      setCard(updated);
      setTabOverride(null); // activeTabKey prefers Spec once needs-user
    } catch (err) {
      setCreateSpecError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSpec(false);
    }
  }

  async function createTasks() {
    if (!card || !card.canCreateTasks) return;
    setCreatingTasks(true);
    setCreateTasksError(null);
    setTabOverride("spec"); // stay on Spec while synthesis runs
    try {
      await flushSpecRef.current?.();
      const updated = await api.createTasks(card.id);
      setCard(updated);
      setTabOverride(null); // activeTabKey prefers Tasks once needs-user
    } catch (err) {
      setCreateTasksError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingTasks(false);
    }
  }

  if (missing) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4">
        <Logo className="size-12" />
        <p className="text-muted-foreground">Card not found.</p>
        <Button variant="outline" onClick={() => navigate("/")}>
          <IconArrowLeft data-icon="inline-start" /> Back to board
        </Button>
      </div>
    );
  }

  if (!card) return null;

  const tabs = visibleSteps(card.steps);
  const defaultTabKey = activeTabKey(card.steps);
  const activeKey =
    tabOverride && tabs.some((s) => s.key === tabOverride) ? tabOverride : defaultTabKey;
  const Panel = STEP_PANELS[activeKey];
  const inBacklog = card.column === "backlog";
  const hasTitle = card.title.trim().length > 0;
  const grillStep = card.steps.find((s) => s.key === "grill");
  const specStep = card.steps.find((s) => s.key === "spec");
  // Local flag for instant UI; card.creatingSpec survives board remounts (SSE/GET).
  const synthesizingSpec = creatingSpec || card.creatingSpec;
  const synthesizingTasks = creatingTasks || card.creatingTasks;
  const showCreateSpec =
    activeKey === "grill" && grillStep !== undefined && grillStep.status !== "done";
  const createSpecDisabled =
    synthesizingSpec || !card.canCreateSpec || grillStarting;
  const showCreateTasks =
    activeKey === "spec" && specStep !== undefined && specStep.status !== "done";
  const createTasksDisabled =
    synthesizingTasks || !card.canCreateTasks || synthesizingSpec;
  const tasksStep = card.steps.find((s) => s.key === "tasks");
  const showImplement =
    activeKey === "tasks" &&
    tasksStep?.status === "needs-user" &&
    tasksFooter !== null;
  const wideLayout = activeKey === "spec" || activeKey === "tasks";

  return (
    <div
      className={cn(
        "mx-auto flex h-dvh flex-col",
        wideLayout ? "max-w-6xl" : "max-w-3xl",
      )}
    >
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")} title="Back to board">
          <IconArrowLeft />
        </Button>
        <span className="truncate font-semibold">{card.title || "Untitled"}</span>
      </header>

      <div className="flex gap-1 border-b px-4">
        {tabs.map((step) => (
          <button
            key={step.key}
            type="button"
            onClick={() => setTabOverride(step.key)}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-2 py-2 text-sm font-medium transition-colors",
              activeKey === step.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {step.label}
          </button>
        ))}
      </div>

      <main className="flex flex-1 flex-col overflow-hidden p-4">
        {Panel ? (
          <Panel
            card={card}
            stepKey={activeKey}
            onCardChange={setCard}
            registerSpecFlush={registerSpecFlush}
            registerTasksFooter={registerTasksFooter}
            synthesizingSpec={synthesizingSpec}
            synthesizingTasks={synthesizingTasks}
            onGrillStartingChange={onGrillStartingChange}
          />
        ) : null}
      </main>

      <footer className="flex items-center gap-2 border-t px-4 py-3">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="sm">
              <IconTrash data-icon="inline-start" />
              Delete
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this card?</AlertDialogTitle>
              <AlertDialogDescription>
                This permanently removes the card from the board.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={remove}>Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        {inBacklog && (
          <>
            <div className="flex-1" />
            <Button
              variant="outline"
              disabled={!hasTitle || deciding}
              onClick={() => decide("standalone")}
            >
              Implement now →
            </Button>
            <Button disabled={!hasTitle || deciding} onClick={() => decide("feature")}>
              Grill me →
            </Button>
          </>
        )}

        {showCreateSpec && (
          <>
            <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
              {createSpecError ? (
                <p className="max-w-md text-right text-sm text-destructive" role="alert">
                  {createSpecError}
                </p>
              ) : null}
            </div>
            <Button disabled={createSpecDisabled} onClick={createSpec}>
              {synthesizingSpec
                ? "Creating Spec…"
                : createSpecError
                  ? "Retry"
                  : "Create Spec →"}
            </Button>
          </>
        )}

        {showCreateTasks && (
          <>
            <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
              {createTasksError ? (
                <p className="max-w-md text-right text-sm text-destructive" role="alert">
                  {createTasksError}
                </p>
              ) : null}
            </div>
            <Button disabled={createTasksDisabled} onClick={() => void createTasks()}>
              {synthesizingTasks
                ? "Creating Tasks…"
                : createTasksError
                  ? "Retry"
                  : "Create Tasks →"}
            </Button>
          </>
        )}

        {showImplement && tasksFooter ? (
          <>
            <div className="flex min-w-0 flex-1 flex-col items-end gap-1">
              {tasksFooter.error ? (
                <p className="max-w-md text-right text-sm text-destructive" role="alert">
                  {tasksFooter.error}
                </p>
              ) : null}
            </div>
            <Button
              disabled={!tasksFooter.canImplement || tasksFooter.implementing}
              onClick={tasksFooter.implement}
            >
              {tasksFooter.implementing ? (
                <IconLoader2 data-icon="inline-start" className="animate-spin" />
              ) : null}
              Implement →
            </Button>
          </>
        ) : null}
      </footer>

      <p className="pointer-events-none fixed bottom-1 left-1/2 -translate-x-1/2 text-xs text-muted-foreground">
        {card.id}
      </p>
    </div>
  );
}
