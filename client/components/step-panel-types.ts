import type { Card } from "@/lib/api";

export type StepPanelProps = {
  card: Card;
  /** Which step tab this panel is rendering (StepExecution serves several). */
  stepKey: string;
  onCardChange: (card: Card) => void;
  /** Spec tab reports the live editor body for footer Create Tasks gates. */
  onSpecBodyChange?: (markdown: string) => void;
  /** Grill tab: Create Spec → headless /to-spec is in flight. */
  synthesizingSpec?: boolean;
};
