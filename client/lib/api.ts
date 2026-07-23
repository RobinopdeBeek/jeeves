export type ColumnId = "backlog" | "define" | "implement" | "review" | "finalize";

export type StepStatus =
  | "pending"
  | "queued"
  | "ai-working"
  | "needs-user"
  | "done";

export type StepKind = "human" | "ai-chat" | "ai-execution";

export interface CardStep {
  key: string;
  status: StepStatus;
  label: string;
  stepKind: StepKind;
  column: ColumnId;
}

export interface Card {
  id: string;
  projectId: string;
  kind: "feature" | "task" | null;
  status: "draft" | "active" | "merged" | "done";
  column: ColumnId | null;
  title: string;
  description: string;
  position: number;
  createdAt: string;
  steps: CardStep[];
  /** Server-derived: grill→spec hand-off is allowed (Create Spec). */
  canCreateSpec: boolean;
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

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status}`);
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
};
