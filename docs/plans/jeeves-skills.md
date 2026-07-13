# Jeeves Skills

> Part of the [Jeeves implementation plan](./jeeves-plan.md).

The quality of the entire system depends on these skills. Each one is a prompt file under
`prompts/execution/` (for AI Execution steps) or an ACP session opener (for AI Chat steps).
The runner **injects inputs explicitly** — skills never hunt the artifact folder or database.
Agents in the worktree may read the per-card `manifest.json`; everything else arrives in the
prompt.

Two transport modes:

| Mode | Steps | Backend | Persistence |
|---|---|---|---|
| **AI Chat** | Grill, Spec side-chat, Tasks side-chat | `AcpBridge` → `agent acp` | `UIMessage[]` transcript + optional host-written summary |
| **AI Execution** | Plan, Implement, AI Review, Tasks, Finalize | `ExecutionEngine` → `@cursor/sdk` local | Harvested artifacts + `runs` row per invocation |

**Structured outputs** (tasks breakdown, notifications) write JSON to a known **exchange path**
under `.jeeves/` in the worktree. The runner harvests, Zod-validates on the host, and retries
with parse-error feedback — never `generateObject`. **Prose outputs** write to exchange paths
(`.jeeves/plan.md`, eval fragment files) or are finalized by the host (grill summary, spec).

Every skill prompt should state: what step it belongs to, what inputs the runner injects, what
it must produce, step **postconditions** (commits allowed? source changes forbidden?), and
what runs next in the pipeline. Skills that emit **notifications** write them to
`.jeeves/notifications.json` (or a per-skill fragment harvested by `/eval-assemble`).

### Shared conventions

- **Vocabulary:** use terms from [`CONTEXT.md`](../../CONTEXT.md); respect ADRs in the target repo.
- **Seams:** specs and plans name the module interfaces under test (see [module map](./jeeves-build-order.md#the-module-map-deep-modules-and-their-seams)).
- **Vertical slices:** task breakdown skills produce independently end-to-end-testable increments,
  not horizontal layers.
- **Lineage:** harvested artifacts record `derived_from` in `artifact_lineage`; skills should
  reference upstream artifacts by path when synthesizing (the runner resolves these).
- **Rework:** `round` and open `change_requests` are injected on rework passes; skills must not
  assume round 0 only.
- **Dogfooding:** skills adapted from Matt Pocock's engineering skills keep their *process* but
  drop issue-tracker publishing — Jeeves is the tracker.

### Skill catalog

#### Backlog → Define Feature

| Skill | Step | Mode | Source | Priority |
|---|---|---|---|---|
| [`grill-with-docs`](#grill-with-docs) | Grill | AI Chat | Adapted from Matt Pocock | P1 |
| [`grill-summary`](#grill-summary) | Grill → Spec hand-off | Host prompt | From scratch | P1 |
| [`spec-assist`](#spec-assist) | Spec side-chat | AI Chat | From scratch | P2 |
| [`to-tasks`](#to-tasks) | Tasks | AI Execution | Adapted from `/to-tickets` | P1 |
| [`to-tasks-revise`](#to-tasks-revise) | Tasks side-chat | AI Chat | Adapted from `/to-tickets` | P2 |
| [`to-rework-tasks`](#to-rework-tasks) | Tasks (rework) | AI Execution | Adapted from `/to-tasks` | P2 |

#### Implement Task

| Skill | Step | Mode | Source | Priority |
|---|---|---|---|---|
| [`plan-implementation`](#plan-implementation) | Plan | AI Execution | From scratch | P1 |
| [`implement-task`](#implement-task) | Implement | AI Execution | Adapted from `/implement` + `/tdd` | P1 |
| [`eval-summary`](#eval-summary) | AI Review (eval pipeline) | AI Execution | From scratch | P2 |
| [`eval-screenshots`](#eval-screenshots) | AI Review | AI Execution / host | From scratch | P2 |
| [`eval-diff-narrative`](#eval-diff-narrative) | AI Review | AI Execution | From scratch | **P0** |
| [`eval-tests`](#eval-tests) | AI Review | AI Execution | From scratch | P2 |
| [`thermo-nuclear-review`](#thermo-nuclear-review) | AI Review | AI Execution | Wire existing Cursor skill | P1 |
| [`eval-qa-plan`](#eval-qa-plan) | AI Review | AI Execution | From scratch | **P0** |
| [`eval-assemble`](#eval-assemble) | AI Review | AI Execution | From scratch | P1 |

#### Human Review (feature scope)

| Skill | Step | Mode | Source | Priority |
|---|---|---|---|---|
| [`eval-acceptance`](#eval-acceptance) | Feature auto-advance → Review | AI Execution | From scratch (incl. refactor pass) | P1 |

#### Finalize

| Skill | Step | Mode | Source | Priority |
|---|---|---|---|---|
| [`document`](#document) | Document | AI Execution | From scratch | P3 |
| [`deploy`](#deploy) | Deploy | AI Execution | From scratch | P3 |

#### Sub-skills (invoked inside other skills, not separate `runs` rows)

| Skill | Invoked by | Source |
|---|---|---|
| [`grilling`](#grilling) | `grill-with-docs` | Matt Pocock — keep as-is |
| [`domain-modeling`](#domain-modeling) | `grill-with-docs` | Matt Pocock — keep as-is |
| [`tdd`](#tdd) | `implement-task` | Matt Pocock — keep as-is |
| [`codebase-design`](#codebase-design) | `eval-acceptance` (refactor pass) | Jeeves — keep as-is |

#### Meta-workflow (building Jeeves itself — not wired into the board)

| Skill | Used when | Notes |
|---|---|---|
| [`to-spec`](#to-spec) | Scoping a slice group before implementation | Publishes to the *human's* issue tracker, not Jeeves cards |
| [`code-review`](#code-review) | After `/implement` on jeeves slices | Standards + Spec axes; the board uses `thermo-nuclear-review` instead for task AI Review |

---

### Skill specifications

#### `grill-with-docs`

- **Step:** Define Feature → Grill (`ai-chat`)
- **Inputs (injected):** card title + description; `CONTEXT.md` path; project `repo_path`
- **Outputs:** `UIMessage[]` chat transcript (artifact, kind `grill`); on hand-off, host runs
  [`grill-summary`](#grill-summary) to produce a markdown grill artifact
- **Behavior:** relentless one-question-at-a-time interview with codebase lookup; invoke
  `/grilling` and `/domain-modeling` inline as decisions crystallise (ADR/glossary updates stay
  in the *target* repo when grilling features for that project). Do not write a spec or task
  breakdown — surface constraints and edge cases only.
- **Workflow awareness:** precedes Spec; summary is the sole input to spec authoring. Re-grill
  invalidates downstream spec/tasks (staleness via `artifact_lineage`).

#### `grill-summary`

- **Step:** Grill → Spec transition (host-controlled, not a `runs` row)
- **Inputs:** full Grill `UIMessage[]` transcript
- **Outputs:** markdown artifact (kind `grill`) with YAML frontmatter — problem statement,
  assumptions, constraints, open questions, readiness assessment
- **Behavior:** synthesise the conversation; no new questions. Fixed hand-off prompt (see
  [slice 5](./jeeves-build-order.md#the-slice-sequence)).
- **Workflow awareness:** explicit input to Spec and, indirectly, `/to-tasks`.

#### `spec-assist`

- **Step:** Define Feature → Spec side-chat (`ai-chat`)
- **Inputs:** grill summary artifact; current spec draft from the editor; card metadata
- **Outputs:** chat transcript; human saves spec markdown (host-written artifact, kind `spec`)
- **Behavior:** collaborative drafting of acceptance criteria — no autonomous publish. The
  acceptance-criteria checklist authored here is the exact list that reappears in the
  feature-level QA gate (`eval-acceptance`). Suggest criteria; human edits in MDXEditor.
- **Workflow awareness:** follows Grill; precedes Tasks. Spec is the primary input to
  `/to-tasks`.

#### `to-tasks`

- **Step:** Define Feature → Tasks (`ai-execution`, first pass)
- **Inputs (injected):** spec artifact; grill summary; `CONTEXT.md`; module map / ADRs;
  existing merged child tasks of this feature (if any)
- **Outputs:** `.jeeves/to-tasks.json` sidecar → harvested → `cards` rows (`status = 'draft'`)
  + `card_blockers` edges + `tasks-breakdown` artifact metadata. **No source commits.**
- **Sidecar schema (Zod-validated):** array of tasks; `depends_on` holds 0-based indices of
  other tasks in the same array (maps to `card_blockers` on harvest):

```json
{
  "tasks": [
    {
      "title": "string",
      "description": "markdown with acceptance criteria + file hints inline",
      "depends_on": [0]
    }
  ]
}
```

- **Behavior:** break the feature into **vertical slices** per `/to-tickets` rules (tracer
  bullets, expand–contract for wide refactors). Each slice is independently demoable. Runner
  creates real card rows — fan-out is a status flip, not a copy. Retry loop on Zod failure.
- **Workflow awareness:** child tasks inherit the feature branch as merge target. Blocker edges
  gate the execution queue. Quality here determines whether children are truly independent.

#### `to-tasks-revise`

- **Step:** Define Feature → Tasks side-chat (`ai-chat`)
- **Inputs:** current draft task list (from DB); spec; user's revision request
- **Outputs:** chat only — human applies edits to drafts in the UI (add/delete/reorder/blockers)
- **Behavior:** answer questions and propose revised breakdowns; do **not** write
  `.jeeves/to-tasks.json` (that is the autonomous `/to-tasks` run on first pass or rework).
  Same vertical-slice discipline as `/to-tasks`.
- **Workflow awareness:** optional refinement before fan-out; does not replace the structured
  sidecar path for bulk creation.

#### `to-rework-tasks`

- **Step:** Define Feature → Tasks on feature rework (`ai-execution`)
- **Inputs (injected):** open `change_requests` (one document); spec; prior round's merged
  tasks (read-only context); feature evaluation artifact if present
- **Outputs:** same sidecar + draft cards as `/to-tasks`; new drafts tagged with
  `round = parent.rework_round`
- **Behavior:** merge overlapping change requests into one task or split a large request across
  slices; may reference prior round tasks but must not mutate them. Requests marked `consumed`
  after hand-off.
- **Workflow awareness:** triggered by "Create tasks →"; precedes another fan-out. Round N
  history stays visible as archived merged children.

#### `plan-implementation`

- **Step:** Implement Task → Plan (`ai-execution`)
- **Inputs (injected):** card title + description (acceptance criteria inline); parent feature
  spec (child tasks); prior plan artifact on rework; `manifest.json`; module seams from spec
- **Outputs:** `.jeeves/plan.md` → harvested plan artifact. **No source commits.**
- **Behavior:** implementation plan for **this slice only** — files to touch, seams to test,
  order of work, risks. Must name pre-agreed test seams. On rework, address open change
  requests without re-planning unrelated scope.
- **Postconditions:** plan artifact required; git tree clean (no source changes).
- **Workflow awareness:** plan is injected into `/implement-task`. Re-plan only when Plan step
  re-queues (not on impl-only rework).

#### `implement-task`

- **Step:** Implement Task → Implement (`ai-execution`)
- **Inputs (injected):** plan artifact; card description; on rework: consumed change-request
  document; `manifest.json`
- **Outputs:** git commits on the card branch; clean tree at exit. Triggers the eval skill
  sequence (same step run continues into AI Review sub-runs).
- **Behavior:** follow the plan; use `/tdd` at pre-agreed seams; run typecheck and tests;
  commit incrementally. **Does not** run `/code-review` — the eval pipeline's
  `thermo-nuclear-review` is the review surface. On rework, prioritise change requests while
  preserving merged predecessor state.
- **Postconditions:** at least one commit; clean working tree.
- **Workflow awareness:** commits are the diff input for all `/eval-*` skills. Implement
  failure preserves diagnostics; Retry discards the worktree from pre-run SHA.

#### `eval-summary`

- **Step:** AI Review pipeline (after Implement)
- **Inputs (injected):** plan artifact; card description; `git diff` since merge-base; commit
  messages; screenshot paths if already captured
- **Outputs:** `.jeeves/eval/fragments/summary.md`
- **Behavior:** what was built, why, and how — written for someone context-switching back.
  Include screenshot/GIF gallery markup (relative paths harvested into artifact folder).
- **Workflow awareness:** first eval fragment; feeds `/eval-assemble`. May emit notifications
  (e.g. "deviation from plan").

#### `eval-screenshots`

- **Step:** AI Review pipeline
- **Inputs (injected):** `preview_config`; evaluated `git_sha`; routes/flows from plan or QA
  plan
- **Outputs:** `.jeeves/screenshots/*` → harvested; references embedded by `/eval-summary` or
  assemble
- **Behavior:** host spins preview at the evaluated SHA; Playwright captures key flows. Falls
  back to text description on capture failure (notification: warning).
- **Workflow awareness:** shares preview manager with Human Review "Start Server"; runs before
  or in parallel with narrative depending on engine scheduling.

#### `eval-diff-narrative`

- **Step:** AI Review pipeline
- **Inputs (injected):** full `git diff` since merge-base; plan artifact; `CONTEXT.md`
- **Outputs:** `.jeeves/eval/fragments/code-changes.md`
- **Behavior:** reorder diff by architectural layer (schema → migrations → API → logic → UI →
  tests), one paragraph per group explaining what and why. Every file reference is a
  `cursor://file/path:line` link. **Hardest skill to get right; highest value for review
  speed.**
- **Workflow awareness:** omitted entirely from Feature Evaluation (links back to per-task
  evals instead).

#### `eval-tests`

- **Step:** AI Review pipeline
- **Inputs (injected):** repo test commands; `git diff` for touched modules
- **Outputs:** `.jeeves/eval/fragments/tests.md` (pass/skip/fail per suite; new tests
  highlighted; regression flags)
- **Behavior:** run the full test suite; capture output. Emit notification on failure or
  missing coverage on touched modules.
- **Workflow awareness:** at feature scope, `/eval-acceptance` runs full regression instead.

#### `thermo-nuclear-review`

- **Step:** AI Review pipeline
- **Inputs (injected):** `git diff` since merge-base; plan artifact
- **Outputs:** `.jeeves/eval/fragments/ai-review.md` — categorised findings (Critical /
  Major / Minor / Suggestion)
- **Behavior:** wire the existing Cursor skill
  (`thermo-nuclear-code-quality-review`); surface-everything pass, not a blocker list. Each
  finding is pushable to "Request changes" in the UI.
- **Workflow awareness:** **task scope only** — Feature Evaluation deliberately omits this
  (covered per child). Findings feed the rework loop via `change_requests.source = 'ai_review'`.

#### `eval-qa-plan`

- **Step:** AI Review pipeline
- **Inputs (injected):** plan artifact; card description (acceptance criteria); diff summary;
  test results
- **Outputs:** `.jeeves/eval/fragments/qa-checklist.md` — behaviour-specific checkbox items
- **Behavior:** actionable, specific checks — not "verify it works". These items gate Approve
  via parent-board `localStorage` + `postMessage`. At feature scope, `/eval-acceptance` merges
  spec acceptance criteria with journey checks.
- **Workflow awareness:** QA gate resets on rework; round badge visible on re-run evaluation.

#### `eval-assemble`

- **Step:** AI Review pipeline (terminal)
- **Inputs (injected):** all eval fragments; per-skill notification sidecars; session meta
  (runs aggregation: duration, tokens, model, cost); `git_sha`
- **Outputs:** `.jeeves/eval.html` (self-contained HTML, sandboxed iframe) +
  `.jeeves/notifications.json` → harvested → `notifications` table rows. **No source commits.**
- **Behavior:** combine fragments into canonical Task Evaluation sections (Summary,
  Notifications, Code changes, Tests, AI review, QA checklist, Metadata); consolidate and
  dedupe notifications (deviation from plan, test gap, critical review finding, unresolved
  uncertainty). Inline CSS; sticky TOC; syntax-highlighted diffs.
- **Postconditions:** eval HTML + notifications required; git tree clean.
- **Workflow awareness:** one assembled eval per task round; supersedes prior version within
  the same round on partial re-run (e.g. re-run narrative + assemble only). Feature Evaluation
  uses a parallel assemble path from `/eval-acceptance`.

#### `eval-acceptance`

- **Step:** Feature → Human Review (after all children merged)
- **Inputs (injected):** spec artifact (acceptance criteria checklist); links to each child
  Task Evaluation; feature branch `git_sha`; full regression results; holistic screenshot
  brief
- **Outputs:** feature-scoped `.jeeves/eval.html` + `notifications.json`
- **Behavior:** **thinner** than task eval — includes Summary, Notifications (feature-level),
  Tasks (links to child evals), Refactor opportunities (adapted from
  `/improve-codebase-architecture` / `codebase-design` vocabulary), Tests (full regression),
  QA (spec criteria + end-to-end journeys), Metadata. **No** diff narrative; **no**
  thermo-nuclear review. Refactor items push to change requests (`source = 'refactor'`).
- **Workflow awareness:** final integration gate before Finalize; "Create tasks →" reworks via
  `/to-rework-tasks`.

#### `document`

- **Step:** Finalize → Document (`ai-execution`)
- **Inputs (injected):** spec; plan/eval artifacts; `git diff` feature-branch → `main`;
  `ARCHITECTURE.md` / README / ADR index
- **Outputs:** commits on the card branch updating affected docs (README sections, ADRs,
  `ARCHITECTURE.md` if structural)
- **Behavior:** document what changed and why; do not duplicate eval prose. New ADRs only for
  decisions not already recorded.
- **Workflow awareness:** precedes `/deploy`; child tasks skip this step.

#### `deploy`

- **Step:** Finalize → Deploy (`ai-execution`)
- **Inputs (injected):** card branch name; project default branch; commit range; eval summary
- **Outputs:** PR opened feature-branch → `main` (or standalone task branch → `main`) via `gh`
  / host CLI; PR body links to evaluation artifact
- **Behavior:** open PR, do not merge. Fail with notification if PR already exists for this
  branch.
- **Workflow awareness:** terminal step for features and standalone tasks.

#### Sub-skills

- **`grilling`:** one question at a time; recommended answer per question; no enactment until
  shared understanding — used inside `grill-with-docs`.
- **`domain-modeling`:** maintain `CONTEXT.md` and ADRs during Grill — used inside
  `grill-with-docs`.
- **`tdd`:** red → green at pre-agreed seams only; invoked by `implement-task` prompt, not a
  separate queue item.
- **`codebase-design`:** module/seam vocabulary for refactor opportunities inside
  `eval-acceptance`.

#### Meta-workflow skills

- **`to-spec`:** synthesise conversation into a spec with testing seams; publish to the human's
  issue tracker. Used to scope jeeves slices — **not** the feature Spec step (that is
  human-authored markdown + `spec-assist`).
- **`code-review`:** Standards + Spec parallel sub-agents against a fixed git point. Used when
  building jeeves; the board's automated path uses `thermo-nuclear-review` + human Review
  instead.

### Eval pipeline sequencing

Task AI Review is not one skill — it is a **sequence** of `runs` rows, displayed as a
mini-pipeline in the RunLog:

```
implement-task  (commits)
      ↓
eval-summary → eval-screenshots → eval-diff-narrative → eval-tests
      ↓
thermo-nuclear-review → eval-qa-plan → eval-assemble
```

Each section skill can be re-run independently (new `runs` row + superseding artifact version)
by re-queuing from the failed section onward, typically through `/eval-assemble` at minimum.

### Development priority

Prioritise prompt quality in this order (P0 = hardest / highest leverage):

| Priority | Skill | Why |
|---|---|---|
| **P0** | `eval-diff-narrative` | Hardest to get right; highest value for review speed |
| **P0** | `eval-qa-plan` | Must be specific and actionable, not generic |
| P1 | `grill-with-docs` + `grill-summary` | Sets the quality ceiling for the whole feature |
| P1 | `to-tasks` | Determines whether child cards are truly independent slices |
| P1 | `plan-implementation` | Bad plans waste entire Implement runs |
| P1 | `implement-task` | Core autonomous builder |
| P1 | `thermo-nuclear-review` | Already exists — wire and constrain scope |
| P1 | `eval-assemble` | Notification consolidation is subtle; HTML contract is the review surface |
| P1 | `eval-acceptance` | Feature-level scoping without re-reviewing slices |
| P2 | `eval-summary`, `eval-screenshots`, `eval-tests` | Fill out the eval; slice 9 stub proves the skeleton |
| P2 | `spec-assist`, `to-tasks-revise`, `to-rework-tasks` | Collaborative refinement paths |
| P3 | `document`, `deploy` | Finalize polish after the happy path works |

**Process:** develop and test each skill independently before wiring it into the pipeline. Run
it manually against a real recent PR or diff (or a real grilling transcript for chat skills)
to validate output quality before trusting it to run automatically. Every rough edge found
while building jeeves is dogfooding feedback for the skills jeeves will run.
