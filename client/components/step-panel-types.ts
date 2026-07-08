import type { Card } from "@/lib/api";

export type StepPanelProps = {
  card: Card;
  /** Which step tab this panel is rendering (StepExecution serves several). */
  stepKey: string;
  onCardChange: (card: Card) => void;
};
