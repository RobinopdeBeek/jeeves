import type { Card } from "@/lib/api";

export type StepPanelProps = {
  card: Card;
  onCardChange: (card: Card) => void;
};
