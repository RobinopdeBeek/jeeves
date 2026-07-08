import type { ComponentType } from "react";
import { StepExecution } from "./StepExecution";
import { StepGrill } from "./StepGrill";
import { StepInfo } from "./StepInfo";
import type { StepPanelProps } from "./step-panel-types";

export type { StepPanelProps } from "./step-panel-types";

export const STEP_PANELS: Record<string, ComponentType<StepPanelProps>> = {
  info: StepInfo,
  grill: StepGrill,
  plan: StepExecution,
  impl: StepExecution,
  airev: StepExecution,
};
