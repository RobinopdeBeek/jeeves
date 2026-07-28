# Task drafts are versioned artifacts, not card rows

Task shaping during a feature's Tasks step lives in append-only `tasks-draft` JSON artifacts scoped by `(card, round)`, not in `cards` rows with `status = 'draft'`. The human (and later the side-chat) edits a tip document with stable task ids and id-based `dependsOn` edges; **Implement →** is a later host `fanOut` that materializes real **active** child cards from that tip. This keeps shaping file-shaped and versioned (Save / Delete / undo / AI harvest each append a tip), avoids two sources of truth before fan-out, and retires ADR 0001's "drafts are cards" model for the Define path.

## Considered Options

- **Draft card rows (`status = 'draft'`)** — rejected for shaping: every edit mutated SQLite cards before fan-out, and ADR 0001's "fan-out is a status flip" forced draft rows to linger as display copies after activation.
- **Spec-style in-place upsert of one JSON file** — rejected: undo and AI revisions need recoverable tips; append-only versions make undo a tip-copy append (refresh-safe) without a separate pointer schema.

## Consequences

- Card lifecycle statuses for board cards are `active | merged | done` (no shaping `draft`). Glossary and plans must not describe draft card rows as the Tasks model.
- Unlike Spec markdown (ADR 0005 in-round upsert), `tasks-draft` is **append-only within the round**; `latest` by `created_at` is the tip. Fan-out freezes the tip as `tasks-breakdown` and prunes older draft versions.
- Skill / exchange JSON may use `depends_on` indices; the host normalizes to stable `id` / `dependsOn` before appending a tip.
- ADR 0001 is superseded for Tasks shaping; fan-out still creates real child `cards` rows, just at Implement → rather than at harvest.
