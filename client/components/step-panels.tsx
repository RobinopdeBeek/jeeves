import type { ComponentType } from "react";
import { StepExecution } from "./StepExecution";
import { StepGrill } from "./StepGrill";
import { StepInfo } from "./StepInfo";
import { StepReview } from "./StepReview";
import { StepSpec } from "./StepSpec";
import { StepTasks } from "./StepTasks";
import type { StepPanelProps } from "./step-panel-types";

export type { StepPanelProps } from "./step-panel-types";

export const STEP_PANELS: Record<string, ComponentType<StepPanelProps>> = {
  info: StepInfo,
  grill: StepGrill,
  spec: StepSpec,
  tasks: StepTasks,
  plan: StepExecution,
  implement: StepExecution,
  "ai-review": StepExecution,
  "prepare-human-review": StepExecution,
  "human-review": StepReview,
};
