import type { ExternalThreadBranchAdapter } from "@assistant-ui/react";
import type { BranchableTranscript, RewindOp } from "@shared/branchable-transcript";
import { emptyTranscript } from "@shared/branchable-transcript";
import { useRef, useState } from "react";
import { useAcpChat, type AcpChatState } from "@/hooks/useAcpChat";
import { api, type ChatThread } from "@/lib/api";
import {
  createProjectChatBranchAdapter,
  switchOpForBranch,
  truncateOpForEdit,
} from "@/lib/project-chat-rewind";
import { toast } from "@/components/ui/sonner";

export type ProjectChatThreadSession = {
  chat: AcpChatState;
  branchable: BranchableTranscript;
  rewinding: boolean;
  pendingSend: { text: string; key: string } | null;
  clearPendingSend: () => void;
  branchAdapter: ExternalThreadBranchAdapter;
  handleModelChange: (model: string | null) => Promise<void>;
  runRewind: (op: RewindOp, sendText?: string) => Promise<void>;
  rewindDisabled: boolean;
};

/**
 * Project Chat thread controller: soft-reattach on Rewind. Model changes apply
 * to the live session (`session/set_config_option`), so they neither remount
 * nor displace anything.
 */
export function useProjectChatThreadSession({
  thread,
  onStreamingSettled,
  onThreadUpdated,
}: {
  thread: ChatThread;
  onStreamingSettled?: () => void;
  onThreadUpdated?: (thread: ChatThread) => void;
}): ProjectChatThreadSession {
  const [rewinding, setRewinding] = useState(false);
  const [pendingSend, setPendingSend] = useState<{
    text: string;
    key: string;
  } | null>(null);
  const [branchable, setBranchable] = useState<BranchableTranscript>(
    emptyTranscript(),
  );
  const branchableRef = useRef(branchable);
  branchableRef.current = branchable;

  const chat = useAcpChat({
    threadId: thread.id,
    softDisplaceReasons: ["rewound"],
    onBranchable: setBranchable,
    onStreamingChange: (streaming) => {
      if (!streaming) onStreamingSettled?.();
    },
  });

  async function handleModelChange(model: string | null) {
    try {
      const updated = await api.setChatThreadModel(thread.id, model);
      onThreadUpdated?.(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not set model");
    }
  }

  async function runRewind(op: RewindOp, sendText?: string) {
    setRewinding(true);
    try {
      const result = await api.rewindChatThread(thread.id, op);
      setBranchable(result.branchable);
      if (result.warm.status === "failed") {
        toast.error(result.warm.error || "Warm agent failed to respawn");
      }
      setPendingSend(
        sendText
          ? { text: sendText, key: `${Date.now()}:${sendText.length}` }
          : null,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not rewind chat");
    } finally {
      setRewinding(false);
    }
  }

  const branchAdapter = createProjectChatBranchAdapter({
    getBranchable: () => branchableRef.current,
    onSwitchBranch: (branchId) => {
      void runRewind(switchOpForBranch(branchId));
    },
  });

  const rewindDisabled =
    rewinding ||
    (chat.status === "ready" &&
      (chat.connection === "reconnecting" || !chat.sessionOpen));

  return {
    chat,
    branchable,
    rewinding,
    pendingSend,
    clearPendingSend: () => setPendingSend(null),
    branchAdapter,
    handleModelChange,
    runRewind,
    rewindDisabled,
  };
}

export { truncateOpForEdit };
