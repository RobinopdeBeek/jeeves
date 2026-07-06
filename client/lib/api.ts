export type ColumnId = "backlog" | "define" | "implement" | "review" | "finalize";

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
}

export interface Project {
  id: string;
  name: string;
  repoPath: string;
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
  deleteCard: (id: string) =>
    request<{ ok: boolean }>(`/api/cards/${id}`, { method: "DELETE" }),
};
