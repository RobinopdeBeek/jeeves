# Pre-review quality + architecture pass

> Future feature — still refining.
>
> Evolves the Feature Evaluation path in [The Evaluation](../jeeves-evaluation.md) and
> [`eval-acceptance`](../jeeves-skills.md#eval-acceptance): today Feature Evaluation
> deliberately **omits** `/thermo-nuclear-review` and only surfaces `/improve-codebase-architecture`
> as passive "Refactor opportunities." This feature runs both **before** Human Review, auto-fixes
> what does not need a human, and leaves only judgment calls in the eval.

## Problem

When all child tasks are merged, the feature branch is the first time the integrated change
exists as a whole. Per-task thermo-nuclear reviews already caught slice-local issues, but
cross-slice quality debt and deepening opportunities only show up on the assembled feature.
Today those land as review homework. Many findings are mechanical enough to fix unattended;
parking all of them for Human Review wastes the review surface and lets fixable debt ride into
Finalize.

## Desired flow

Trigger: **all children of the current round are merged**, immediately before the feature
auto-advances into Human Review (same moment `eval-acceptance` would start today).

```
all children merged
      ↓
pre-review pass (feature branch worktree)
  ┌─────────────────────────────────────┐
  │  parallel sub-agents                │
  │  • /thermo-nuclear-code-quality-…   │
  │  • /improve-codebase-architecture   │
  └─────────────────────────────────────┘
      ↓
aggregate + combine findings
      ↓
classify each finding
  ├─ auto-fixable → apply + commit on feature branch
  └─ needs user input → keep for Feature Evaluation
      ↓
eval-acceptance / assemble (eval reflects post-fix SHA)
      ↓
Human Review
```

### 1. Parallel sub-agents

Spawn both skills in one turn as independent sub-agents (same pattern as `/code-review`'s
Standards + Spec axes — separate contexts, no cross-contamination):

| Sub-agent | Skill | Focus |
|---|---|---|
| Quality | `/thermo-nuclear-code-quality-review` | Structural quality of the **feature-branch diff** vs merge-base (or default branch): spaghetti growth, file-size, abstraction, casts, boundary leaks, missed code-judo |
| Architecture | `/improve-codebase-architecture` | Deepening opportunities across the integrated feature: shallow modules, seam placement, locality/leverage — using `CONTEXT.md` + ADR vocabulary |

Scope is **feature-level**, not a re-run of each child's task review. Prefer findings that only
make sense once slices are merged (cross-module friction, duplicated patterns across tasks,
feature-shaped modules that never coalesced).

### 2. Aggregate and combine

A host skill (working name: `pre-review-aggregate`) merges the two reports into one finding
list:

- Deduplicate overlapping items (same files / same deepening described from both axes).
- Preserve axis provenance (`quality` | `architecture` | `both`) so the eval can still show
  where a finding came from.
- Rank / group for the classifier — do not silently drop either axis's high-conviction items.

Do **not** re-rank across axes the way `/code-review` refuses to; combining here means
dedupe + classify for actionability, not picking a single winner.

### 3. Classify: auto-fix vs needs input

| Bucket | Examples | Action |
|---|---|---|
| **Auto-fix** | Clear code-judo with an obvious local rewrite; delete a thin wrapper; extract a helper already named in the finding; collapse duplicate branches; move logic to an existing canonical helper; type-boundary cleanup with no product trade-off | Apply on the feature branch, commit, re-run tests; include a short "Auto-fixed" summary in the eval |
| **Needs user input** | ADR-touching deepenings; product/UX trade-offs; "Strong" architecture candidates that need grilling; anything that would change public behaviour or reopen a recorded decision; speculative / worth-exploring items | Land in the Feature Evaluation only (see below) |

Classification is itself a skill concern: when unsure, **prefer needs-input**. Auto-fix must
not invent product decisions.

### 4. Auto-fix then evaluate

1. Apply auto-fix findings (possibly one commit per finding, or one batch commit — TBD).
2. Tests / typecheck must pass; failure rolls the auto-fix back (or leaves the finding as
   needs-input with a "attempted fix failed" note) — never advance with a red tree.
3. Run Feature Evaluation (`eval-acceptance` + assemble) against the **post-fix** `git_sha`.
4. Advance the feature card to Human Review.

Board UX: show this as a mini-pipeline on the feature (similar to task AI Review), e.g.

```
Pre-review
  ✓ quality sub-agent
  ✓ architecture sub-agent
  ✓ aggregate + classify
  ⟳ auto-fix (3 findings)
  ○ eval-acceptance
```

### 5. What goes into the final eval

The Feature Evaluation's former passive **"Refactor opportunities"** section becomes the home
for **needs-input findings only** (quality + architecture), each still pushable with `+` into
"Request changes" → `/to-rework-tasks`.

Also add a short **"Auto-fixed"** subsection (or Notifications entries) listing what was fixed
unattended — so Human Review can audit the automatic pass without re-deriving it.

Task Evaluations stay unchanged: per-slice thermo-nuclear remains on children. This pass does
not replace them.

## Relationship to current plans

| Today ([jeeves-evaluation.md](../jeeves-evaluation.md)) | This feature |
|---|---|
| Feature eval: **no** thermo-nuclear | Feature-scoped thermo-nuclear **before** eval, auto-fix first |
| `/improve-architecture` folded into "Refactor opportunities" for humans | Architecture runs as a live sub-agent; only unresolved items stay in the eval |
| Refactor items → change requests via `+` | Unchanged for needs-input; auto-fix never waits for `+` |
| `eval-acceptance` starts on auto-advance | Pre-review pass runs first; `eval-acceptance` consumes its output + post-fix SHA |

`human-review-understanding.md` already wants "Nuclear-Review + Improve-Architecture" as a
review section after understanding — this feature is the **autonomous pre-pass**; the eval
section remains the human-facing residue.

## Open questions

- Exact skill name / `runs` rows: one orchestrator run with nested sub-agents, or three
  sequenced runs (`quality`, `architecture`, `aggregate-fix`) plus `eval-acceptance`?
- Diff base for the quality pass: feature merge-base vs default branch tip?
- Auto-fix commit policy: one commit vs many; attribution in commit messages?
- Should Critical quality findings that *could* auto-fix still notify even when fixed?
- Cap on auto-fix scope (LOC / files) so a runaway rewrite cannot silently reshape the feature?
- How this interacts with feature rework Round N — re-run the full pass, or only on new
  deltas since last pre-review?
