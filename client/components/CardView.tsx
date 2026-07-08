import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Card, type KindPath } from "@/lib/api";
import {
  activeTabKey,
  visibleSteps,
} from "@/lib/card-steps";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
import { StepGrillShell } from "./StepGrillShell";
import { StepPlanShell } from "./StepPlanShell";

export function CardView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [card, setCard] = useState<Card | null>(null);
  const [missing, setMissing] = useState(false);
  const [activeKey, setActiveKey] = useState("info");
  const [deciding, setDeciding] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!id) return;
    api
      .getCard(id)
      .then((loaded) => {
        setCard(loaded);
        setActiveKey(activeTabKey(loaded.steps));
      })
      .catch(() => setMissing(true));
  }, [id]);

  function autoSave(patch: { title?: string; description?: string }) {
    if (!card) return;
    setCard({ ...card, ...patch });
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      api.updateCard(card.id, patch).catch(console.error);
    }, 400);
  }

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
      setActiveKey(activeTabKey(decided.steps));
    } catch (err) {
      console.error(err);
    } finally {
      setDeciding(false);
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
  const inBacklog = card.column === "backlog";
  const hasTitle = card.title.trim().length > 0;

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")} title="Back to board">
          <IconArrowLeft />
        </Button>
        <span className="truncate font-semibold">{card.title || "Untitled"}</span>
      </header>

      {tabs.length > 1 && (
        <div className="flex gap-1 overflow-x-auto border-b px-4">
          {tabs.map((step) => (
            <button
              key={step.key}
              type="button"
              onClick={() => setActiveKey(step.key)}
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
      )}

      {tabs.length === 1 && (
        <div className="border-b px-4">
          <div className="-mb-px inline-flex border-b-2 border-primary px-1 py-2 text-sm font-medium">
            Info
          </div>
        </div>
      )}

      <main className="flex flex-1 flex-col overflow-hidden p-4">
        {activeKey === "info" && (
          <div className="flex flex-1 flex-col gap-4 overflow-y-auto">
            <div className="flex flex-col gap-1.5">
              <label htmlFor="card-title" className="text-sm font-medium">
                Title
              </label>
              <Input
                id="card-title"
                value={card.title}
                placeholder="What should be built?"
                onChange={(e) => autoSave({ title: e.target.value })}
              />
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <label htmlFor="card-desc" className="text-sm font-medium">
                Description
              </label>
              <Textarea
                id="card-desc"
                value={card.description}
                placeholder="Describe the idea in markdown…"
                className="flex-1 resize-none"
                onChange={(e) => autoSave({ description: e.target.value })}
              />
            </div>
          </div>
        )}
        {activeKey === "grill" && <StepGrillShell />}
        {activeKey === "plan" && <StepPlanShell />}
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
      </footer>
    </div>
  );
}
