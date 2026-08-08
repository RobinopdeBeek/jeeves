# Step revert (Define)

> Escape hatch when a later miss traces back to a weak Grill / Spec / Tasks hand-off.
> Complementary to [simple rework flow](./simple-rework-flow.md) (CRs fix small misses in Review; Revert undoes a bad Define cut).

## Goal

If implementation went wrong because upstream artifacts were ill-defined, go **back** to an earlier Define step and cut everything that depended on it — not polish with Change Requests.

Once **Grill**, **Spec**, or **Tasks** is `done`, that step shows a **Revert** control. Revert reopens that step and **removes all later step state** for the card (and any work that only existed because of those later steps).

## UX

- On a **done** Grill, Spec, or Tasks tab: a **Revert** button (confirm dialog — destructive).
- After confirm:
  - Target step returns to `needs-user` (editable again: Spec unfreezes, Tasks tip editable, Grill chat usable).
  - Every **later** step on that feature is cleared / reset (not merely marked stale).
  - Card column moves back to **Define** on the reverted step’s tab if it had already left Define.
- No Revert on Info, or on steps that are still in progress / not yet done.
- v1 scope is **Define Feature** only (Grill → Spec → Tasks). Implement-column revert is out of scope unless we need it later.

## What each Revert cuts

Pipeline order: Grill → Spec → Tasks → (fan-out children / Review / …).

| Revert to | Keep | Remove |
|---|---|---|
| **Grill** | Grill transcript + ability to continue; Info | Grill session hand-off used by Spec if we regenerate on next advance; Spec artifact; Tasks tip + history; any fanned-out children and their branches/artifacts/runs; Review/Finalize state for this feature |
| **Spec** | Grill (done) + Spec markdown (editable again) | Tasks tip + history; fan-out children and downstream; Review/Finalize for this feature |
| **Tasks** | Grill + Spec (done); Tasks tip (editable again) | Fan-out: active/merged child cards, blockers, child branches/worktrees/artifacts/runs as needed; feature Review/Finalize progress that assumed those children |

Exact deletion vs soft-archive can follow store conventions; the user-facing rule is: **later work is gone from the board and is not what the next advance continues from.**

## Fan-out is the hard case

**Revert Tasks** (or earlier) after **Implement →** has already created child tasks:

- Children may be mid-Implement, in Review, or merged into the feature branch.
- Revert must **tear down or abandon** that fan-out: remove/archive child cards from the board, stop queued/running steps, drop preview/worktrees for those children.
- **Git:** prefer not to rewrite merged history silently. v1 options (pick one in implementation):
  - **Strict:** block Revert while any child is merged or the feature branch has moved past fan-out — user must finish/abandon children first; or
  - **Allowed with confirm:** delete/archive child cards and leave feature-branch commits as orphaned history (new fan-out creates new child branches). Document that branch cleanup is manual/optional.

Call the danger out in the confirm dialog (“This removes N child tasks and their runs”).

## Relation to other flows

| Flow | When |
|---|---|
| **Simple rework (CRs)** | Implementation direction was fine; QA found small fixes |
| **Step Revert** | Spec/Tasks/Grill was wrong; continuing forward compounds the mistake |
| **Restart step** (build-order polish) | Re-run the *current* step’s agent/work without erasing downstream — different control |

Revert is not Round N. It is a deliberate rollback of the Define cut.

## Non-goals (YAGNI)

- No Revert on Plan / Implement / AI Review in v1.
- No partial “revert one child only” from the feature Tasks tab.
- No automatic git reset of the feature branch to pre-fan-out SHA (unless we later choose the strict git-linked variant).
- No time-travel UI over every artifact version — reopen the step, delete downstream, edit forward again.

## Reasoning

A bad Spec or a wrong task breakdown is not a Change Request list. CR rework assumes the slice was aimed at the right target. When the target was wrong, the honest move is to reopen Grill/Spec/Tasks, throw away the work that depended on that hand-off, and advance again with better artifacts.
