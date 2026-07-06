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
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
}

export type KindPath = "feature" | "standalone";

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
  deleteCard: (id: string) =>
    request<{ ok: boolean }>(`/api/cards/${id}`, { method: "DELETE" }),
};
