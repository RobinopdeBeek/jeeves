import type { UIMessage } from "ai";
import type {
  BranchableTranscript,
  RewindOp,
} from "@shared/branchable-transcript";

export type {
  BranchableTranscript,
  BranchNode,
  RewindOp,
} from "@shared/branchable-transcript";

export type ColumnId = "backlog" | "define" | "implement" | "review" | "finalize";

export type StepStatus =
  | "pending"
  | "queued"
  | "ai-working"
  | "needs-user"
  | "awaiting"
  | "done";

export type StepKind = "human" | "ai-chat" | "ai-execution";

export interface CardStep {
  key: string;
  status: StepStatus;
  label: string;
  stepKind: StepKind;
  column: ColumnId;
}

export type BlockedByRef = { id: string; title: string };

/** Child task payload rich enough to render the same board `CardTile`. */
export type CardChildSummary = {
  id: string;
  title: string;
  description: string;
  kind: Card["kind"];
  status: Card["status"];
  column: ColumnId | null;
  position: number;
  steps: CardStep[];
  blockedBy: BlockedByRef[];
  creatingSpec: boolean;
  creatingTasks: boolean;
  implementProgress: ImplementProgress | null;
};

export type ImplementProgress = {
  current: number;
  total: number;
};

export interface Card {
  id: string;
  projectId: string;
  parentCardId: string | null;
  kind: "feature" | "task" | null;
  status: "active" | "merged" | "done";
  column: ColumnId | null;
  title: string;
  description: string;
  branch: string | null;
  position: number;
  createdAt: string;
  steps: CardStep[];
  blockedBy: BlockedByRef[];
  children: CardChildSummary[];
  implementProgress: ImplementProgress | null;
  /** Server-derived: grill→spec hand-off is allowed (Create Spec). */
  canCreateSpec: boolean;
  /** Server-derived: spec→tasks hand-off is allowed (Create Tasks). */
  canCreateTasks: boolean;
  /** True while create-spec synthesis is in flight (survives remounts). */
  creatingSpec: boolean;
  /** True while create-tasks synthesis is in flight (survives remounts). */
  creatingTasks: boolean;
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
}

export type KindPath = "feature" | "standalone";

export interface Run {
  id: string;
  cardId: string;
  stepKey: string;
  round: number;
  skill: string;
  status: "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt: string | null;
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  cost: number | null;
  error: string | null;
  logPath: string | null;
}

export interface RunWithLog extends Run {
  log: string;
}

export interface ArtifactContent {
  id: string;
  cardId: string;
  stepKey: string;
  round: number;
  kind: string;
  gitSha: string | null;
  createdAt: string;
  content: string;
}

export interface TasksDraftTask {
  id: string;
  title: string;
  description: string;
  dependsOn: string[];
}

export interface TasksDraft {
  tasks: TasksDraftTask[];
}

/** Tip document as returned by tip CRUD routes (includes append-only version count). */
export type TasksDraftTip = TasksDraft & {
  versionCount: number;
};

/** Project Chat thread index row (transcript lives on disk under the project store). */
export interface ChatThread {
  id: string;
  projectId: string;
  title: string;
  model: string | null;
  createdAt: string;
  updatedAt: string;
  lastOpenedAt: string | null;
  /** Live warm ACP mid-turn — present on list responses for the chat rail. */
  aiWorking?: boolean;
}

/** Agent model row for the Project Chat picker (ACP session config option). */
export interface AgentModel {
  /** ACP config value — a variant string like `composer-2.5[fast=true]`. */
  id: string;
  displayName: string;
  current: boolean;
  default: boolean;
}

/** Card Info library attachment (ADR 0017 Phase 2) — not a chat-turn sidecar. */
export interface CardAttachment {
  id: string;
  cardId: string;
  filename: string;
  mediaType: string;
  path: string;
  instruction: string;
  originStep: string;
  sizeBytes: number;
  createdAt: string;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = `${init?.method ?? "GET"} ${url} → ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // keep status-based message
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

/** Like `request`, but leaves Content-Type unset (multipart FormData). */
async function requestForm<T>(url: string, form: FormData): Promise<T> {
  const res = await fetch(url, { method: "POST", body: form });
  if (!res.ok) {
    let detail = `POST ${url} → ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) detail = body.error;
    } catch {
      // keep status-based message
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export const api = {
  getProject: () => request<Project>("/api/project"),
  listCards: () => request<Card[]>("/api/cards"),
  createCard: () => request<Card>("/api/cards", { method: "POST" }),
  getCard: (id: string) => request<Card>(`/api/cards/${id}`),
  updateCard: (id: string, patch: { title?: string; description?: string }) =>
    request<Card>(`/api/cards/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  decideCard: (id: string, path: KindPath) =>
    request<Card>(`/api/cards/${id}/decide`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  createSpec: (id: string) =>
    request<Card>(`/api/cards/${id}/create-spec`, { method: "POST" }),
  createTasks: (id: string) =>
    request<Card>(`/api/cards/${id}/create-tasks`, { method: "POST" }),
  implement: (id: string) =>
    request<Card>(`/api/cards/${id}/implement`, { method: "POST" }),
  putSpec: (id: string, content: string) =>
    request<ArtifactContent>(`/api/cards/${id}/spec`, {
      method: "PUT",
      body: JSON.stringify({ content }),
    }),
  getTasksDraft: (id: string) => request<TasksDraftTip>(`/api/cards/${id}/tasks`),
  putTasksDraft: (id: string, draft: TasksDraft) =>
    request<TasksDraftTip>(`/api/cards/${id}/tasks`, {
      method: "PUT",
      body: JSON.stringify(draft),
    }),
  deleteTasksDraftTask: (id: string, taskId: string) =>
    request<TasksDraftTip>(`/api/cards/${id}/tasks/${taskId}`, {
      method: "DELETE",
    }),
  undoTasksDraft: (id: string) =>
    request<TasksDraftTip>(`/api/cards/${id}/tasks/undo`, { method: "POST" }),
  deleteCard: (id: string) =>
    request<{ ok: boolean }>(`/api/cards/${id}`, { method: "DELETE" }),
  listRuns: (cardId: string) => request<Run[]>(`/api/cards/${cardId}/runs`),
  getRun: (id: string) => request<RunWithLog>(`/api/runs/${id}`),
  getLatestArtifact: (
    cardId: string,
    params: { stepKey: string; round: number; kind: string },
  ) => {
    const qs = new URLSearchParams({
      stepKey: params.stepKey,
      round: String(params.round),
      kind: params.kind,
    });
    return request<ArtifactContent>(`/api/cards/${cardId}/artifacts/latest?${qs}`);
  },
  retryStep: (cardId: string, stepKey: string) =>
    request<Card>(`/api/cards/${cardId}/steps/${stepKey}/retry`, {
      method: "POST",
    }),

  listChatThreads: () => request<ChatThread[]>("/api/chat-threads"),
  createChatThread: () =>
    request<ChatThread>("/api/chat-threads", { method: "POST" }),
  getChatThread: (id: string) => request<ChatThread>(`/api/chat-threads/${id}`),
  getLastOpenedChatThread: () =>
    request<ChatThread>("/api/chat-threads/last-opened"),
  renameChatThread: (id: string, title: string) =>
    request<ChatThread>(`/api/chat-threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  setChatThreadModel: (id: string, model: string | null) =>
    request<ChatThread>(`/api/chat-threads/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ model }),
    }),
  openChatThread: (id: string) =>
    request<ChatThread>(`/api/chat-threads/${id}/open`, { method: "POST" }),
  deleteChatThread: (id: string) =>
    request<{ ok: boolean }>(`/api/chat-threads/${id}`, { method: "DELETE" }),
  getChatThreadTranscript: (id: string) =>
    request<BranchableTranscript>(`/api/chat-threads/${id}/transcript`),
  rewindChatThread: (id: string, op: RewindOp) =>
    request<{
      messages: UIMessage[];
      branchable: BranchableTranscript;
      warm: { status: "open" } | { status: "failed"; error: string };
    }>(`/api/chat-threads/${id}/rewind`, {
      method: "POST",
      body: JSON.stringify(op),
    }),
  listModels: () => request<{ models: AgentModel[] }>("/api/models"),

  /**
   * Upload a Project Chat turn attachment; returns a pointer ChatAttachment
   * (`jeeves-attachment://chat/…`) for the WS send.
   */
  uploadChatThreadAttachment: (threadId: string, file: File) => {
    const form = new FormData();
    form.append("file", file);
    return requestForm<{
      mediaType: string;
      filename?: string;
      url: string;
    }>(`/api/chat-threads/${threadId}/attachments`, form);
  },

  /**
   * Upload a step-chat turn attachment; returns a pointer ChatAttachment
   * (`jeeves-attachment://step/…`) for the WS send.
   */
  uploadStepChatAttachment: (
    cardId: string,
    stepKey: string,
    file: File,
  ) => {
    const form = new FormData();
    form.append("file", file);
    return requestForm<{
      mediaType: string;
      filename?: string;
      url: string;
    }>(`/api/cards/${cardId}/chat-attachments/${stepKey}`, form);
  },

  listCardAttachments: (cardId: string) =>
    request<CardAttachment[]>(`/api/cards/${cardId}/attachments`),
  addCardAttachment: (
    cardId: string,
    file: File,
    opts?: { instruction?: string; originStep?: string },
  ) => {
    const form = new FormData();
    form.append("file", file);
    if (opts?.instruction !== undefined) {
      form.append("instruction", opts.instruction);
    }
    form.append("originStep", opts?.originStep ?? "info");
    return requestForm<CardAttachment>(
      `/api/cards/${cardId}/attachments`,
      form,
    );
  },
  updateCardAttachmentInstruction: (
    cardId: string,
    attachmentId: string,
    instruction: string,
  ) =>
    request<CardAttachment>(`/api/cards/${cardId}/attachments/${attachmentId}`, {
      method: "PATCH",
      body: JSON.stringify({ instruction }),
    }),
  deleteCardAttachment: (cardId: string, attachmentId: string) =>
    request<{ ok: boolean }>(
      `/api/cards/${cardId}/attachments/${attachmentId}`,
      { method: "DELETE" },
    ),
  /** HTTP URL for library attachment bytes (not a jeeves-attachment:// pointer). */
  cardAttachmentUrl: (cardId: string, attachmentId: string) =>
    `/api/cards/${cardId}/attachments/${attachmentId}`,
};
