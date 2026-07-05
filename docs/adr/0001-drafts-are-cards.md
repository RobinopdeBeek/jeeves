# Drafts are cards, not a separate entity

When a feature is broken into vertical slices, each draft slice is a real `cards` row with `status = 'draft'` — there is no `draft_tasks` table. Fan-out is a status flip to `active`, not a copy, so there is never a draft row and a card row describing the same task that can drift apart. This also makes the "archived Round N tasks" view a plain query (merged children of an earlier round) instead of a separate archival structure, and lets the Tasks tab render drafts, running tasks, and merged tasks as one list of cards in three states.

## Considered Options

A separate `draft_tasks` table (draft spawns a card at fan-out, keeping a `spawned_card_id` back-pointer) was rejected: the draft had to stay behind as a display copy after fan-out, creating two sources of truth for the same task.

## Consequences

- Every board query must filter `status = 'active'`; drafts and merged children are excluded by status, not by table.
- `column` is nullable — a draft is not on the board and has no column until activated.
- Discarding a draft is a hard delete (cascading its blocker edges); there is no tombstone status.
