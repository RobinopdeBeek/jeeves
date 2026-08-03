# AI Review reworks code; Evaluation is created on Human Review entry

The Implement Task column is `/implement` split into three steps and three context windows: Plan (light planning, including Context7 when needed), Implement (`/tdd` at pre-agreed seams), and AI Review (dual-axis Standards + Spec review in the shape of `/code-review`, then **immediate rework** in the same step). AI Review runs as **one** `@cursor/sdk` invocation, does a **single** review→rework pass (no verify loop), and harvests an audit **review** artifact for process evidence — not the Human Review Evaluation.

The **Evaluation** HTML is created by an explicit Review-column step, **Prepare Eval** (`prepeval`), which runs before the human **Review** step and pins the eval to the commit tip after AI Review. AI Review no longer feeds eval fragments; earlier plan text that treated AI Review as the eval pipeline (or forbade AI Review commits) is superseded. Slice 8 ships Plan → Implement → AI Review, advances into Review with `prepeval` queued, and stubs Prepare Eval enough to finish; slice 9 replaces that stub with the real assemble pipeline.

## Considered options

- **AI Review only reports (no rework)** — rejected: the interactive `/implement` flow fixes what review finds before the human looks; splitting steps should not drop that.
- **Eval fragments produced inside AI Review** — rejected: couples review/rework to the review surface; human eval should reflect the post-rework tip as one assemble-on-entry artifact.
- **Verify loop inside AI Review** — rejected for v1: unbounded cost/time; Human Review remains the quality gate after one honest rework pass.
