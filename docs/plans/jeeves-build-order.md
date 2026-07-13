# Build Order

> Part of the [Jeeves implementation plan](./jeeves-plan.md).

## Build Order

> Built in **vertical slices** (tracer bullets), not horizontal layers. Each slice cuts through
> every layer it touches — schema → module → API → UI → test — and ends with something demoable.
> The sequence is ordered by risk: the scariest unknowns get a thin end-to-end path first.
> Vocabulary from the `codebase-design` skill: **module**, **interface**, **seam**, **depth**.

### The module map (deep modules and their seams)

Five deep modules, each a small interface hiding a lot of behaviour. These are the
**pre-agreed seams**: every spec sketches its testing against them (`/to-spec` step 2), and all
TDD happens at them. The HTTP routes and the React client are thin adapters over these
modules, not modules of their own.

| Module | Interface (the seam) | What it hides |
|---|---|---|
| `PipelineEngine` | pipeline lookup by `(kind, hasParent)`; `advance(card)` | all column/step transition rules, auto-advance, "workflow is code" |
| `CardStore` | CRUD, kind decision, fan-out, blocker edges, derived queries ("X of Y", queue candidates, Round N history) | SQLite/Drizzle, the unified draft/active/merged model, every derivation rule |
| `ArtifactStore` | `save`, `harvest(worktree, declarations)`, `list(card)`, serve-path resolution | atomic/versioned files, metadata, containment, manifest regeneration, lineage, rounds, supersession |
| `ExecutionEngine` | `enqueue(card, step)` + run events; `startPreview(card, gitSha)` / `stopPreview()` | `AgentRunner` (today: `@cursor/sdk` local), `WorktreeManager`, per-run worktrees/finalization, branch strategy, sequential queue, host-process preview lifecycle, blocker checks, restart recovery, eval-skill sequencing |
| `AcpBridge` | `openSession(skillPrompt)` → `UIMessage` stream | spawning `agent acp`, ACP→`UIMessage` projection, permission responses, JSON-RPC piping, disconnect/summary handling |

### The slice sequence

Each slice below is one slice-sized tracer bullet. Blockers are noted; slices without a
blocker relationship can be built in parallel or reordered.

1. **Walking skeleton: a card on the board.** Minimal `cards` schema, `CardStore`
   create/list, board with tiles, responsive layout, reachable from the phone over Tailscale.
   *Demo: create a card on your phone, see it appear.*
2. **Kind decision moves a card.** Info tab, "Grill me →" / "Implement now →",
   `PipelineEngine` lookup + `advance`. *Demo: a card walks its pipeline's columns.*
   (Blocked by 1.)
3. **Tracer bullet: one real autonomous run.** *(Done — issue #6; execution path migrating per
   [ADR 0010](../adr/0010-self-managed-worktrees-cursor-sdk.md).)* `ExecutionEngine` in its
   thinnest form — originally `SandcastleAgentRunner` (Docker); target is `CursorSdkAgentRunner`
   + `WorktreeManager` running a single queued Plan step on the tracer prompt (`slice-3-tracer`:
   create + commit `hello.txt` in an isolated branch worktree), a `runs` row is written, the log
   streams live over SSE. **Spike validated:** `@cursor/sdk` local + self-managed worktrees on
   native Windows (PARTIAL GO — sandbox unavailable, runs without it). *Demo: Implement now →,
   watch Plan go ai-working → done from the board.* (Blocked by 2.)
4. **Artifact round-trip.** `ArtifactStore`: finalize the host-written run log plus harvest a
   required uncommitted `.jeeves/plan.md`; store immutable, root-relative indexed versions;
   serve over HTTP; render formatted read-only Plan beneath a collapsible run log. Completed
   logs load collapsed but do not collapse while watched. Markdown uses GFM without raw HTML.
   *Demo: a run's Plan and frozen log viewable from the phone.* (Blocked by 3.) The runner uses
   a fresh `createWorktree()` per run and a pre-cleanup finalization callback; harvest failure
   fails atomically. The branch becomes `jeeves/card-<id>` (no per-step suffix), with explicit
   local default branch/base SHA. See [ADR 0009](../adr/0009-branches-durable-worktrees-ephemeral.md).
5. **Grill end-to-end.** Establish the chat stack: `useChat` + assistant-ui over a custom
   WebSocket `ChatTransport`; `AcpBridge` projects ACP JSON-RPC into AI SDK `UIMessage` parts
   server-side (including permission-request custom parts). `StepGrill` renders streaming
   chat; conversation summary saved as a `UIMessage[]` artifact on hand-off. *Demo: a
   `/grill-with-docs` session from the phone.* (Blocked by 1 only — independent of 3–4, can
   run in parallel.)

   **Grill → Spec hand-off summary prompt:**
```
Summarise this entire conversation as a structured markdown document.
Include: the problem statement as clarified, key assumptions surfaced,
constraints identified, open questions remaining, and a readiness assessment.
This will be used as input to /to-spec.
```
6. **Spec step.** MDXEditor + AI side-chat reusing the chat stack from slice 5; spec artifact
   with the acceptance-criteria checklist. *Demo: author a spec collaboratively from the
   tablet.* (Blocked by 5.)
7. **Fan-out.** `/to-tasks` writes a structured JSON sidecar in the worktree (vertical
   slices + blocked-by); the runner harvests it and validates with a Zod schema before creating
   draft cards (retry loop on parse failure). Draft cards (real `cards` rows, `status =
   'draft'`) with add/delete/edit and blocker edges; "Implement →" flips drafts to `active`;
   feature shows "Implementing Task X of Y". *Demo: a feature becomes child cards on the
   board.* (Blocked by 6.)
8. **Full task pipeline.** Plan → Implement → AI Review sequencing inside `ExecutionEngine`;
   each run gets a fresh worktree on the same durable card branch and receives prior artifacts
   explicitly; blocker-aware queue rebuilt from `card_steps` on restart; orphaned `running` runs
   marked `failed` at boot; branch strategy onto the feature branch (or configured default for
   standalone), with step-specific postconditions.
   *Demo: a child task runs all three steps unattended.* (Blocked by 4 and 7.)
9. **Evaluation walking skeleton.** `eval-assemble` only — a minimal HTML evaluation (Tests +
   QA checklist), `notifications.json` sidecar, harvested, rendered with
   `sandbox="allow-scripts"`. Parent-owned browser storage synchronizes QA through validated
   `postMessage` and drives the QA-gated Approve button. A preview-manager sub-slice wires
   Start Server → readiness → Open in Browser + Stop against the evaluation's exact SHA using
   Jeeves-owned host-process `preview_config`. *Demo: start and review a real slice from your
   phone; the gate flips when QA completes.* (Blocked by 8.)
10. **Approve & merge.** `decisions` rows with the `qa_complete` snapshot; child approval first
    validates a temporary merge against the current feature tip, then merges and leaves the
    board (conflict/failure returns it for rework); feature auto-advances when all children are
    merged; standalone/feature enter Finalize. *Demo: the full happy path, Backlog → merged.*
    (Blocked by 9.)
11. **Evaluation filled out.** The remaining eval skills — `eval-summary`,
    `eval-screenshots`, `eval-diff-narrative`, `eval-tests`, `/thermo-nuclear-review`,
    `eval-qa-plan` — one `runs` row per invocation, plus the mini-pipeline display rendered
    from `runs`. Each prompt is developed and validated independently (see
    [Jeeves Skills](./jeeves-skills.md)) and wired in
    one at a time. (Blocked by 9; each section is its own sub-slice.)
12. **Rework loop — task.** "Request changes" panel, `+` push from AI-review findings,
    request consumption into the rework prompt, round increment, evaluation persisted
    read-only, `changes_requested` decision row. *Demo: reject a slice, watch Round 2 arrive.*
    (Blocked by 10.)
13. **Rework loop — feature.** Feature Evaluation (`eval-acceptance`, incl. refactor
    opportunities), "Create tasks →" with the rework breakdown skill, Round N history in the
    Tasks tab. (Blocked by 12.)
14. **Finalize + polish.** Document and Deploy steps; browser push on entering Human Review;
    notification dots (`COUNT(*) WHERE read_at IS NULL`); session meta from `runs`;
    "Restart step" button; step-history sidebar. (Blocked by 10.)

Note the inversion versus a layered plan: the review *loop* works first with a stub-quality
evaluation (slice 9), then the evaluation's sections improve one prompt at a time (slice 11) —
instead of building all seven eval skills before anything renders.

### How the slices get built (the meta-workflow)

This plan document is not the issue list — it's the grilling output. From here, jeeves is
built with the same workflow it automates:

1. **Grilling** — done: this plan plus [`CONTEXT.md`](../../CONTEXT.md) are its artifacts.
2. **`/to-spec`** per slice group — each spec confirms its testing seams against the module
   map above.
3. **`/to-tasks`** — produces roughly the slice sequence above as tracer-bullet tasks with
   blocked-by edges.
4. **`/implement` with `/tdd`** — red → green at the pre-agreed seams (the module
   interfaces), one slice at a time.
5. **`/code-review`** against the merge-base — Standards axis + Spec axis (the spec).

Every rough edge found in the skills while building jeeves is dogfooding feedback for the
pipeline jeeves will run.

---
