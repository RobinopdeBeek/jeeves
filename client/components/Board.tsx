import { IconPlus } from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, type Card, type ColumnId } from "@/lib/api";
import { COLUMNS } from "@/lib/columns";
import { useJeevesEvents } from "@/lib/events";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { CardTile } from "./CardTile";

export function Board() {
  const navigate = useNavigate();
  const [cards, setCards] = useState<Card[]>([]);
  const [activeCol, setActiveCol] = useState<ColumnId>("backlog");

  useEffect(() => {
    api.listCards().then(setCards).catch(console.error);
  }, []);

  useJeevesEvents(
    (event) => {
      if (event.type !== "card.updated") return;
      setCards((prev) => {
        const exists = prev.some((c) => c.id === event.card.id);
        return exists
          ? prev.map((c) => (c.id === event.card.id ? event.card : c))
          : [...prev, event.card];
      });
    },
    // SSE reconnect may have missed card.updated events during the gap.
    () => api.listCards().then(setCards).catch(console.error),
  );

  async function addCard() {
    const card = await api.createCard();
    navigate(`/cards/${card.id}`);
  }

  const cardsIn = (col: ColumnId) => cards.filter((c) => c.column === col);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <main className="min-h-0 flex-1 overflow-x-auto overflow-y-hidden">
        <div className="flex h-full min-w-max gap-3 p-3">
          {COLUMNS.map((col) => (
            <section
              key={col.id}
              className={cn(
                "w-[19rem] shrink-0 flex-col rounded-lg border bg-secondary/40",
                // Mobile: only the active column is visible; desktop: all five.
                col.id === activeCol ? "flex" : "hidden md:flex",
                "max-md:w-full",
              )}
            >
              <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <div>
                  <div className="text-sm font-semibold">{col.name}</div>
                  <div className="text-xs text-muted-foreground">{col.sub}</div>
                </div>
                {col.id === "backlog" && (
                  <Button variant="outline" size="sm" onClick={addCard}>
                    <IconPlus data-icon="inline-start" /> Add card
                  </Button>
                )}
              </div>
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                {cardsIn(col.id).length === 0 ? (
                  <div className="py-8 text-center text-xs text-muted-foreground">No cards</div>
                ) : (
                  cardsIn(col.id).map((card) => <CardTile key={card.id} card={card} />)
                )}
              </div>
            </section>
          ))}
        </div>
      </main>

      <nav className="flex shrink-0 border-t bg-background md:hidden">
        {COLUMNS.map((col) => (
          <button
            key={col.id}
            type="button"
            onClick={() => setActiveCol(col.id)}
            className={cn(
              "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]",
              col.id === activeCol ? "font-semibold text-foreground" : "text-muted-foreground",
            )}
          >
            <span>{col.short}</span>
            <span className="rounded-full bg-secondary px-1.5 text-[10px]">
              {cardsIn(col.id).length}
            </span>
          </button>
        ))}
      </nav>
    </div>
  );
}
