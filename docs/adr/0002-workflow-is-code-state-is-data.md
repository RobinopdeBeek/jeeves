# Workflow is code, state is data

The pipelines (kind → columns → steps) are TypeScript constants looked up by `(kind, hasParent)`; the database stores only per-card state (`cards`, `card_steps`) and immutable round-scoped records (`artifacts`, `runs`, `change_requests`, `decisions`, `notifications`). We rejected seeding workflow definitions into the database because there is no workflow editor, and the step semantics are welded to code anyway — the runner knows `impl` triggers the eval pipeline and `tasks` fans out children, which no database row can express. Workflow-as-data would have been a shadow copy of what the code already knows.

## Consequences

- Changing a pipeline's shape is a code change plus a data migration for in-flight cards' `card_steps` rows.
- A companion rule follows: current-state tables (`cards`, `card_steps`) hold one mutable row per thing with no round column; history is never reconstructed from them but read from the round-scoped record tables. The execution queue is likewise derived (steps with status `queued`, minus blocked cards) and rebuilt from the database on restart, never persisted itself.
