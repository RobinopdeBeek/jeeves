import { IconArrowLeft, IconTrash } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api, type Card } from "@/lib/api";
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

/**
 * Full-page card view. Slice 1: only the Info tab (title + description with
 * auto-save) and delete. The kind decision ("Grill me →" / "Implement now →")
 * arrives in slice 2.
 */
export function CardView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [card, setCard] = useState<Card | null>(null);
  const [missing, setMissing] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    if (!id) return;
    api
      .getCard(id)
      .then(setCard)
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

  if (missing) {
    return (
      <div className="flex h-dvh flex-col items-center justify-center gap-4">
        <p className="text-muted-foreground">Card not found.</p>
        <Button variant="outline" onClick={() => navigate("/")}>
          <IconArrowLeft data-icon="inline-start" /> Back to board
        </Button>
      </div>
    );
  }

  if (!card) return null;

  return (
    <div className="mx-auto flex h-dvh max-w-3xl flex-col">
      <header className="flex items-center gap-2 border-b px-4 py-2.5">
        <Button variant="ghost" size="icon-sm" onClick={() => navigate("/")} title="Back to board">
          <IconArrowLeft />
        </Button>
        <span className="truncate font-semibold">{card.title || "Untitled"}</span>
        <div className="flex-1" />
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon-sm" title="Delete card">
              <IconTrash className="text-destructive" />
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
      </header>

      <div className="border-b px-4">
        <div className="-mb-px inline-flex border-b-2 border-primary px-1 py-2 text-sm font-medium">
          Info
        </div>
      </div>

      <main className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
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
      </main>
    </div>
  );
}
