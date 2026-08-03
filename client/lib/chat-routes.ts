/** Where bare `/chat` should land given viewport + last-opened memory. */
export type BareChatDestination =
  | { kind: "list" }
  | { kind: "thread"; threadId: string }
  | { kind: "empty" };

/**
 * Desktop restores the last-opened Chat Thread; mobile keeps the list at `/chat`.
 * Deep links (`/chat/:threadId`) are handled by the route table, not this helper.
 */
export function resolveBareChatDestination(
  isDesktop: boolean,
  lastOpenedId: string | null,
): BareChatDestination {
  if (!isDesktop) return { kind: "list" };
  if (lastOpenedId) return { kind: "thread", threadId: lastOpenedId };
  return { kind: "empty" };
}
