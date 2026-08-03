import {
  createContext,
  useContext,
  type ReactNode,
} from "react";

export type ProjectChatRewindApi = {
  /** Sibling branch ids for a message (incl. itself); empty if unknown. */
  getBranches: (messageId: string) => readonly string[];
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
