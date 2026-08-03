# AI Review reworks code; Evaluation is created on Human Review entry

The Implement Task column is `/implement` split into three steps and three context windows: Plan (light planning, including Context7 when needed), Implement (`/tdd` at pre-agreed seams), and AI Review (dual-axis Standards + Spec review in the shape of `/code-review`, then **immediate rework** in the same step). AI Review runs as **one** `@cursor/sdk` invocation, does a **single** review→rework pass (no verify loop), and harvests an audit **review** artifact for process evidence — not the Human Review Evaluation.

The **Evaluation** HTML is created by an explicit Review-column step, **Prepare Eval** (`prepeval`), which runs before the human **Review** step and pins the eval to the commit tip after AI Review. AI Review no longer feeds eval fragments; earlier plan text that treated AI Review as the eval pipeline (or forbade AI Review commits) is superseded. Slice 8 ships Plan → Implement → AI Review, advances into Review with `prepeval` queued, and stubs Prepare Eval enough to finish; slice 9 replaces that stub with the real assemble pipeline.

## Host verify (slice 8)

After Implement succeeds, and again after AI Review if that step made commits, `ExecutionEngine` runs Jeeves-owned **`projects.verify_commands`** (ordered shell commands in the worktree, env allowlist parallel to preview). Non-zero exit fails the step (`needs-user`) with log evidence. Null/empty skips verify (with a warning) for fixtures. Reviewed branches cannot change the gate.

## Considered options

- **AI Review only reports (no rework)** — rejected: the interactive `/implement` flow fixes what review finds before the human looks; splitting steps should not drop that.
- **Eval fragments produced inside AI Review** — rejected: couples review/rework to the review surface; human eval should reflect the post-rework tip via **Prepare Eval**.
- **Verify loop inside AI Review** — rejected for v1: unbounded cost/time; host verify + Human Review remain the quality gates after one honest rework pass.
- **Prompt-only testing with no host gate** — rejected: auto-advance to Review must not depend on the model remembering to test.
