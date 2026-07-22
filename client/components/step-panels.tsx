import type { ComponentType } from "react";
import { StepExecution } from "./StepExecution";
import { StepGrill } from "./StepGrill";
import { StepInfo } from "./StepInfo";
import { StepSpec } from "./StepSpec";
import type { StepPanelProps } from "./step-panel-types";

export type { StepPanelProps } from "./step-panel-types";

export const STEP_PANELS: Record<string, ComponentType<StepPanelProps>> = {
  info: StepInfo,
  grill: StepGrill,
  spec: StepSpec,
  plan: StepExecution,
  impl: StepExecution,
  airev: StepExecution,
};
