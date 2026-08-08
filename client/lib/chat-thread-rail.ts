import type { ChatThread } from "@/lib/api";

/**
 * Merge list `aiWorking` into local busy ids. The active thread stays optimistic
 * (its live WS is authoritative); background threads settle when the list says idle.
 */
export function mergeBusyFromList(
  prev: ReadonlySet<string>,
  listed: ChatThread[],
  activeId: string | undefined,
): { busy: Set<string>; settled: string[] } {
  const byId = new Map(listed.map((t) => [t.id, t]));
  const busy = new Set<string>();
  const settled: string[] = [];

  for (const t of listed) {
    if (t.aiWorking) busy.add(t.id);
  }

  if (activeId && prev.has(activeId)) {
    busy.add(activeId);
  }

  for (const id of prev) {
    if (id === activeId) continue;
    const row = byId.get(id);
    if (!row) continue;
    if (row.aiWorking) busy.add(id);
    else settled.push(id);
  }

  return { busy, settled };
}
