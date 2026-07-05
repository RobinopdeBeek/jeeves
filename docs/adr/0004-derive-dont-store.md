# Derive, don't store

Anything computable from existing rows is computed at read time, never stored, because a stored copy can contradict its source. Child vs standalone task is derived from `parent_card_id` (a stored discriminator could disagree with the link); the execution queue is derived from `card_steps` status plus blocker edges and rebuilt from the database on restart; "Task X of Y", session cost, artifact supersession and staleness, round history, and the eval mini-pipeline display are all queries or aggregations over existing rows.

## Consequences

- There is no persisted queue: on boot the queue is rebuilt and orphaned `running` runs are marked `failed`.
- Artifact supersession is "latest `created_at` per `(card, step, round, kind)` wins" — no status flag to keep in sync.
- Adding a cached/denormalised column requires revisiting this ADR; the default answer is no.
