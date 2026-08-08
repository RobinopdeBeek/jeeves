import type { BranchableTranscript } from "@shared/branchable-transcript";
import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

export type ProjectChatRewindApi = {
  /**
   * Authoritative branch tree. Updated by WS `ready` / rewind / live
   * `branchable` pushes so sibling pickers appear without remounting.
   */
  branchable: BranchableTranscript;
  onSwitchBranch: (branchId: string) => void;
  /** Edit-and-send: server rewind truncate, then send the new text. */
  onEditMessage: (messageId: string, text: string) => void;
  disabled?: boolean;
};

const ProjectChatRewindContext = createContext<ProjectChatRewindApi | null>(
  null,
);

export function ProjectChatRewindProvider({
  value,
  children,
}: {
  value: ProjectChatRewindApi;
  children: ReactNode;
}) {
  return (
    <ProjectChatRewindContext.Provider value={value}>
      {children}
    </ProjectChatRewindContext.Provider>
  );
}

export function useProjectChatRewind(): ProjectChatRewindApi | null {
  return useContext(ProjectChatRewindContext);
}
