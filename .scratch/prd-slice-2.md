# Slice 2: Kind decision moves a card

## Problem Statement

Slice 1 lets a user capture cards in Backlog and edit title/description on an Info tab, but every card stays in Backlog forever — there is no way to commit to a pipeline path. The board cannot yet express the core jeeves workflow: choosing whether work is a **feature** (define collaboratively) or a **standalone task** (implement directly), then seeing the card move to the right **column** with visible **step** progress.

Without the **kind decision**, the board is a static capture list rather than a pipeline monitor.

## Solution

Add the one-time, irreversible **kind decision** on the Info tab: **Grill me →** (feature → Define column) or **Implement now →** (standalone task → Implement column). After deciding, the card moves on the board, shows a segmented progress bar and current-step label on its tile, and opens a multi-tab card view landing on the active step. Grill and Plan tabs are layout shells only — real chat and execution arrive in later slices.

Rename **+ Add issue** to **+ Add card** everywhere, matching domain vocabulary.

## User Stories

1. As a user capturing an idea, I want to click **+ Add card** on the board, so that I can start a new card without legacy "issue" terminology.
2. As a user on a new card, I want an Info tab with title and description fields that auto-save, so that I can flesh out the idea before committing to a path.
3. As a user with an empty title, I want **Grill me →** and **Implement now →** disabled, so that I cannot advance a card without naming it.
4. As a user with a title filled in, I want **Grill me →** and **Implement now →** enabled in the card footer, so that I can choose my pipeline path in one click.
5. As a user choosing **Grill me →**, I want the card to become a **feature** and move to the **Define** column, so that I can start the collaborative define phase.
6. As a user choosing **Implement now →**, I want the card to become a **standalone task** and move to the **Implement** column, so that I can skip define and go straight to implementation (when slice 3 wires execution).
7. As a user who just decided, I want the card view to auto-jump to the active step tab (Grill or Plan), so that I immediately see where I am in the pipeline.
8. As a user on a feature after deciding, I want to see **Info** and **Grill** tabs only (PRD and Tasks hidden until reached), so that the tab bar reflects my actual progress.
9. As a user on a standalone task after deciding, I want to see **Info** and **Plan** tabs only (Implement and AI Review hidden while pending), so that future steps don't clutter the UI.
10. As a user on the Grill tab, I want a chat-layout shell (message area + composer chrome) with no live AI wiring, so that slice 5 can drop in ACP without rebuilding layout.
11. As a user on the Plan tab, I want a run-log layout shell showing queued status, so that slice 3 can stream logs into an existing panel.
12. As a user who navigates back to the board after deciding, I want the card in its new column with a segmented progress bar and current-step label, so that I can monitor pipeline position at a glance.
13. As a user reviewing the board, I want feature cards to show a flag icon on the tile, so that I can distinguish features from tasks visually.
14. As a user with a card that needs my attention (any step `needs-user`, or in Review column), I want a needs-you border on the tile, so that I know where to check in asynchronously.
15. As a user on a feature in Define with Grill `needs-user`, I want the needs-you border on the tile, so that the Grill step surfaces on the board before chat is wired.
16. As a user who picked the wrong path, I want to delete the card and create a new one, so that I can recover without a reverse-kind control (kind decision is irreversible by design).
17. As a user returning to the Info tab after deciding, I want to keep editing title and description, so that I can refine the idea while grilling or waiting for execution.
18. As a user on mobile, I want the board to show the correct column contents when I navigate back (refetch on mount), so that the card appears in Define or Implement even though I may still be viewing the Backlog column tab.
19. As a developer, I want `POST /api/cards/:id/decide` to return 400 when title is blank, so that the server enforces the title precondition even if the client is bypassed.
20. As a developer, I want `POST /api/cards/:id/decide` to return 409 when kind is already set, so that the kind decision cannot be applied twice.
21. As a developer, I want card API responses to embed enriched step rows (`key`, `status`, `label`, `stepKind`), so that the client never imports pipeline definitions.
22. As a developer, I want an `info` step row created when a card is created (`needs-user`), so that Backlog cards have consistent step data without client-side synthesis.
23. As a developer, I want existing Backlog cards without step rows to receive an `info` row on first read or via migration backfill, so that slice-1 data remains valid.

## Implementation Decisions

### Modules

- **PipelineEngine** (new): workflow-as-code constants. Pipeline lookup by `(kind, hasParent)` — `hasParent` derived from `parent_card_id`, included in the interface from day one even though slice 2 only exercises `(feature, false)` and `(task, false)`. Exposes transition logic for the kind decision and step enrichment (label, stepKind per step key).
- **CardStore** (extended): `createCard` also inserts the `info` step row. New `decideKind(cardId, path)` where `path` is `feature` | `standalone`. Delegates column/step transitions to PipelineEngine. List/get responses embed enriched steps. Guards: 400 if title blank; 409 if kind already set.
- **Card routes** (extended): thin adapter — `POST /api/cards/:id/decide` with body `{ "path": "feature" | "standalone" }`. Existing PATCH remains title/description only.
- **React client** (extended): CardView gains step tabs, footer actions, stub step panels, active-tab jump. CardTile gains progress bar, current step, needs-you border, feature flag. Board button renamed to **+ Add card**.

### Schema

Add `card_steps` table (current-state only, one row per card+step):

- `id`, `card_id`, `step_key`, `status` (`pending` | `queued` | `ai-working` | `needs-user` | `done`)
- `started_at`, `completed_at` (nullable; overwritten on rework in later slices)

Migration adds table and backfills `info` rows for existing cards.

### Step rows at kind decision

**Lazy per column, cumulative through current column** — not the whole future pipeline.

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

### API contract

- `GET /api/cards` and `GET /api/cards/:id` return cards with `steps: Array<{ key, status, label, stepKind }>` where `stepKind` is `human` | `ai-chat` | `ai-execution`
- `POST /api/cards/:id/decide` body: `{ "path": "feature" | "standalone" }` → full card with steps; 400 blank title; 409 if kind ≠ null

### UI behaviour (layout/behaviour from prototype; styling secondary)

**Card view footer (Backlog only):** Delete left; **Implement now →** (outline) and **Grill me →** (primary) right. Header: back + title only.

**Tab visibility:** Info always visible. Any step with status `pending` is hidden (stricter than prototype's PRD/Tasks-only rule — applies to task path too).

**Active tab after decide:** Jump to active step using prototype priority (from `board-shared.js`):

```
activeStep = first needs-user
  ?? first ai-working
  ?? first pending
  ?? last work step
```

Re-use this rule for future step hand-offs.

**Board tile (post-decide):** Segmented bar shows steps in the **current column** only (`stage === column`). Below it, current-step label with status icon. Feature flag icon when `kind === feature`. Needs-you border when any work step is `needs-user` OR `column === review`.

**Board refresh:** Refetch card list on Board mount (no SSE in this slice).

**Mobile:** No auto-focus of active column after decide — noted for later polish.

### Prototype-derived logic (trimmed)

Tab visibility (slice 2 rule — all pending hidden):

```
if step is Info → visible
if step.status === 'pending' → hidden
else → visible
```

Kind decision step statuses (prototype `advance()`):

```
feature:     info=done, grill=needs-user, prd=pending, tasks=pending
standalone:  info=done, plan=queued, impl=pending, airev=pending
```

## Testing Decisions

### What makes a good test

Test **external behaviour at the module seam**, not implementation details. Assert on card column, kind, step keys/statuses, and HTTP status codes — not internal PipelineEngine call order or SQL shape. The React client is a thin adapter; no component unit tests in this slice unless needed for a regression guard.

### Seam

**One primary seam: `CardStore`** (in-memory SQLite via `:memory:`, matching slice 1's `store.test.ts` prior art). PipelineEngine is tested **through** `CardStore.decideKind` unless pure transition tables warrant a tiny isolated suite for `(kind, hasParent)` lookup.

### Cases to cover

- `createCard` inserts `info` step (`needs-user`) alongside the card row
- `decideKind(..., 'feature')` moves to Define, sets step statuses as specified, returns enriched steps
- `decideKind(..., 'standalone')` moves to Implement, `plan` is `queued`, no execution side effect
- `decideKind` → 400 when title is blank/whitespace
- `decideKind` → 409 when kind already set
- `listCards` / `getCard` embed steps with `label` and `stepKind`
- Existing tests for CRUD remain green

### Prior art

`server/cards/store.test.ts` — Vitest, `openDb(":memory:")`, `beforeEach` store setup.

Optional: one HTTP-level test for `POST /decide` status codes if the project already has route tests; not required if CardStore coverage is thorough.

## Out of Scope

- ExecutionEngine / Sandcastle / real Plan run (slice 3)
- AcpBridge / live Grill chat (slice 5)
- PRD editor, Tasks fan-out, child tasks, parent chips, task numbering (slices 6–7)
- Human Review, Evaluation, Approve, rework loop (slices 9+)
- SSE / live board updates (slice 14)
- Mobile column auto-focus after decide
- Reversing a kind decision
- `parent_card_id` / child-task pipeline (slice 7) — seam accepts `hasParent` but slice 2 does not exercise it
- Artifacts, runs, notifications, decisions tables

## Further Notes

- Domain term **Kind decision** is recorded in `CONTEXT.md`.
- ADR 0002 (workflow is code, state is data) and ADR 0006 (thin adapters over five deep modules) govern this slice.
- Demo tip: the **feature** path (Grill `needs-user` + needs-you border) is the stronger slice-2 demo; standalone Plan `queued` will look idle until slice 3.
- Blocked by slice 1 (walking skeleton) — assumed complete.
