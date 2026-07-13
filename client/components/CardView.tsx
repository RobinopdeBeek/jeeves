import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { useEffect, useState } from "react";
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

export function CardView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [card, setCard] = useState<Card | null>(null);
  const [missing, setMissing] = useState(false);
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (!id) return;
    setTabOverride(null);
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

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col">
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
        {Panel ? <Panel card={card} stepKey={activeKey} onCardChange={setCard} /> : null}
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
