import type { Card } from "@/lib/api";

export type StepPanelProps = {
  card: Card;
  /** Which step tab this panel is rendering (StepExecution serves several). */
  stepKey: string;
  onCardChange: (card: Card) => void;
  /** Spec tab: register flush-before-Create-Tasks (cleared on unmount). */
  registerSpecFlush?: (flush: (() => Promise<void>) | null) => void;
  /** Grill tab: Create Spec → headless /to-spec is in flight. */
  synthesizingSpec?: boolean;
};
