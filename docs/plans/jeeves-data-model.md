# Data Model

> Part of the [Jeeves implementation plan](./jeeves-plan.md).

## Data Model

> Designed in a grilling session against the prototype; canonical vocabulary lives in
> [`CONTEXT.md`](../../CONTEXT.md). Two rules shape everything below:
>
> 1. **Workflow is code, state is data.** The pipelines (kind → columns → steps) are TypeScript
>    constants; the database stores only per-card state. There is no workflow editor, so
>    workflow-as-data would be a shadow copy of what the runner already knows.
> 2. **Current-state tables vs record tables.** Tables that say *where things stand* (`cards`,
>    `card_steps`) hold one mutable row per thing, no round column. Tables that say *what
>    happened* (`artifacts`, `runs`, `change_requests`, `decisions`, `notifications`) hold
>    immutable round-scoped rows. History is never reconstructed from current-state tables.

### Tables

```
projects
  id            pk
  name          text
  repo_path     text        -- worktree base for the runner
  default_branch text       -- explicit local base ref; never inferred from host HEAD
  preview_config text/json, nullable
                              -- Jeeves-owned host-process setup/dev/port/readiness/env policy
  created_at

cards                        -- one entity for features, tasks, AND drafts
  id            pk
  project_id    fk → projects
  parent_card_id fk → cards, nullable   -- set = child task; null task = standalone
  kind          'feature' | 'task' | null   -- null while undecided in Backlog
  status        'draft' | 'active' | 'merged' | 'done'
  column        'backlog' | 'define' | 'implement' | 'review' | 'finalize' | null
                                        -- null while status = 'draft' (not on the board)
  title         text
  description   text        -- markdown; acceptance criteria & file hints live inline
  branch        text, nullable
  rework_round  int, default 0          -- the card's current round counter
  round         int, default 0          -- for child tasks: the round that created them
  position      int         -- ordering among sibling tasks / drafts
  created_at

card_steps                   -- CURRENT state only; one row per (card, step), mutated in place
  id            pk
  card_id       fk → cards
  step_key      'info' | 'grill' | 'spec' | 'tasks' | 'plan' | 'impl' | 'airev'
                | 'review' | 'document' | 'deploy'
  status        'pending' | 'queued' | 'ai-working' | 'needs-user' | 'done'
  started_at, completed_at   -- overwritten on rework; per-round timing lives in runs
                             -- rows created lazily as the card reaches each column

card_blockers                -- blocked-by edges between cards (drafts and active tasks)
  card_id           fk → cards (cascade delete)
  blocks_on_card_id fk → cards (cascade delete)

change_requests              -- record table; never deleted on consumption
  id            pk
  card_id       fk → cards
  round         int          -- the round they were raised against
  text          text
  source        'manual' | 'ai_review' | 'refactor'
  status        'open' | 'consumed'
  created_at

runs                         -- one row per SKILL INVOCATION (not per step)
  id            pk
  card_id       fk → cards
  step_key      text
  round         int
  skill         text         -- e.g. 'implement-task', 'eval-diff-narrative'
  status        'running' | 'succeeded' | 'failed'
  started_at, finished_at
  model         text
  tokens_in, tokens_out int
  cost          real
  error         text, nullable  -- short message; full context in the log file
  log_path      text            -- log lives in the artifact folder, never in the DB
  base_sha      text, nullable  -- exact ref resolved before the run
  head_sha      text, nullable  -- workspace HEAD when finalization completed

artifacts                    -- metadata + pointer, never content
  id            pk
  card_id       fk → cards
  step_key      text
  round         int
  kind          'grill' | 'spec' | 'tasks-breakdown' | 'plan' | 'eval'
                | 'screenshot' | 'runlog' | 'attachment'
  path          text         -- root-relative; unique immutable destination per version
  git_sha       text, nullable  -- mandatory for evals: the only link to the reviewed diff
  schema_version int
  created_at

artifact_lineage             -- provenance graph (grill → spec → tasks → plan → impl → eval)
  artifact_id              fk → artifacts
  derived_from_artifact_id fk → artifacts

decisions                    -- one immutable row per review exit
  id            pk
  card_id       fk → cards
  round         int          -- the round being reviewed
  decision      'approved' | 'changes_requested'
  qa_complete   boolean      -- the QA-gate snapshot at decision time
  created_at

notifications                -- inserted at harvest from eval-assemble's sidecar JSON
  id            pk
  card_id       fk → cards
  round         int
  type          'critical' | 'warning' | 'info'
  title, body   text
  read_at       timestamp, nullable   -- null = unread → drives the tile dot
```

### The unified card model

Draft tasks are **not** a separate entity: the moment `/to-tasks` (or the rework breakdown
skill) produces a harvested, Zod-validated JSON sidecar and the runner creates card rows,
a real `cards` row exists with `status = 'draft'`. Fan-out is a status flip to `active`, not
a copy. What falls out:

- The Tasks tab renders one list of child cards in three states — draft (editable), active
  (live board cards inline), merged (read-only, grouped by `round`). The prototype's
  `draftTasks` / `archivedTasks` / "display copy after fan-out" machinery all disappear.
- "Archived Round N tasks" is a query: children `WHERE status = 'merged' AND round < parent.rework_round`.
- Board queries filter `status = 'active'`; drafts and merged children never appear.
- Discarding a draft is a hard delete (cascades its blocker edges). Deleting an active card
  is the destructive confirm-dialog path.

Child vs standalone task is **derived from `parent_card_id`**, never stored — a stored
discriminator could contradict the link. The pipeline constant is looked up by `(kind, hasParent)`.

### Derivation rules (what is deliberately NOT stored)

| Not stored | Derived from |
|---|---|
| Execution queue | `card_steps WHERE status = 'queued'`, minus cards with unmerged blockers; rebuilt on restart. Orphaned `running` runs are marked `failed` at boot. |
| Eval mini-pipeline display | `runs` of the current `(card, step, round)`, in order |
| Session metadata (tokens/cost/duration) | SUM over `runs` — per step, per round, or per card |
| "Implementing Task X of Y" | COUNT over the feature's active/merged children of the current round |
| Artifact superseded/stale | Latest `created_at` per `(card, step, round, kind)` wins; staleness = an upstream artifact in `artifact_lineage` has a newer version |
| QA checkbox state | Ephemeral parent-board `localStorage`, synchronized with the sandboxed eval iframe by validated `postMessage`; only `decisions.qa_complete` persists |
| Round history / review history | The sequence of `decisions` rows; requests of a `changes_requested` decision = `change_requests` at that round |
| "Changes added later" (Info tab) | `change_requests WHERE status = 'consumed'` |

### Consumption lineage

Change requests are consumed **as a set**: the open requests at "Implement changes →" are
injected into the rework implement prompt (task), or handed as one input document to the
rework breakdown skill (feature), which may merge or split them into draft tasks — so there
is deliberately **no** request→task FK. Round-level lineage (these requests → that round's
tasks) is the granularity that matters, and file-level provenance is covered by
`artifact_lineage` on the breakdown artifact.

---
