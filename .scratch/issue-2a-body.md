## Parent

#1

## What to build

Add persistent step state and the irreversible **kind decision** on the server. Cards gain a `card_steps` table (one row per card+step, current state only). A new **PipelineEngine** module owns workflow-as-code: pipeline lookup by `(kind, hasParent)` — `hasParent` derived from `parent_card_id`, included from day one even though only `(feature, false)` and `(task, false)` are exercised here — plus kind-decision transitions and step enrichment (`label`, `stepKind` per step key).

**CardStore** extends: `createCard` also inserts an `info` step (`needs-user`); new `decideKind(cardId, path)` where `path` is `feature` | `standalone`, delegating column/step transitions to PipelineEngine; list/get responses embed enriched steps. Guards: 400 if title is blank/whitespace; 409 if kind is already set. Migration adds the table and backfills `info` rows for existing Backlog cards.

Thin route adapter: `POST /api/cards/:id/decide` with body `{ "path": "feature" | "standalone" }` → full card with steps. `GET /api/cards` and `GET /api/cards/:id` return `steps: Array<{ key, status, label, stepKind }>` where `stepKind` is `human` | `ai-chat` | `ai-execution`. Client API types and a `decideCard` helper only — no UI changes in this slice.

Step rows are **lazy per column, cumulative through current column** — not the whole future pipeline.

On `createCard`: insert `info` step with status `needs-user`.

On `decide` with `path: feature`:
- Set `kind: feature`, `column: define`
- Mark `info` → `done`
- Insert Define-column steps: `grill` → `needs-user`, `prd` → `pending`, `tasks` → `pending`

On `decide` with `path: standalone`:
- Set `kind: task`, `column: implement` (no parent → standalone task pipeline)
- Mark `info` → `done`
- Insert Implement-column steps: `plan` → `queued`, `impl` → `pending`, `airev` → `pending`
- **Do not enqueue execution** — `queued` is persisted only; ExecutionEngine arrives in slice 3

## Acceptance criteria

- [ ] `card_steps` table exists with `id`, `card_id`, `step_key`, `status` (`pending` | `queued` | `ai-working` | `needs-user` | `done`), `started_at`, `completed_at`
- [ ] Migration backfills `info` rows for existing cards without step data
- [ ] `createCard` inserts an `info` step with status `needs-user`
- [ ] `decideKind(..., 'feature')` moves card to Define, sets step statuses as specified, returns enriched steps
- [ ] `decideKind(..., 'standalone')` moves card to Implement, `plan` is `queued`, no execution side effect
- [ ] `decideKind` returns 400 when title is blank/whitespace
- [ ] `decideKind` returns 409 when kind is already set
- [ ] `listCards` / `getCard` embed steps with `label` and `stepKind`
- [ ] `POST /api/cards/:id/decide` exposes the above behaviour
- [ ] CardStore seam tests cover all cases (Vitest, in-memory SQLite, matching `store.test.ts` prior art)
- [ ] Existing slice-1 CRUD tests remain green

## Blocked by

None — can start immediately
