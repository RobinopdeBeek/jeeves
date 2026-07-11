# Jeeves

A personal workflow board that runs an AI-assisted development pipeline: cards move through phase columns, typed steps run inside each column, and artifacts accumulate per step while the human reviews asynchronously.

## Language

**Card**:
The unit of work that lives on the board and moves through columns. Every card has a kind that determines its pipeline.
_Avoid_: Issue, ticket

**Kind**:
The pipeline family of a card: Feature or Task. Undecided for cards still in Backlog.

**Kind decision**:
The one-time, irreversible Backlog exit where a card's kind is chosen: "Grill me →" makes it a feature, "Implement now →" makes it a standalone task. Requires a title; a wrong choice is undone by deleting the card, never by reversing the decision.
_Avoid_: Advance (that's any pipeline transition; this is specifically the first one)

**Feature**:
A card that is defined collaboratively (Grill → PRD → Tasks), fans out into child tasks, and is reviewed and finalized as a whole.

**Task**:
A card that implements one vertical slice autonomously (Plan → Implement → AI Review). A **child task** has a parent feature and merges into its branch; a **standalone task** has no parent and finalizes itself. Child vs standalone is derived from the parent link, never stored.

**Vertical slice**:
An independently end-to-end-testable increment of a feature — what a task implements. A slice is the work; the task is the card that carries it.
_Avoid_: Using "slice" to mean the card itself

**Column**:
A lane on the board that a card occupies: Backlog, Define, Implement, Review, or Finalize. Steps belong to a column.
_Avoid_: Stage, phase, "shape" (legacy id for Define)

**Pipeline**:
The ordered list of columns a card kind passes through. Defined in code per kind, not in the database.

**Evaluation**:
The generated, self-contained HTML report a review works from, pinned to the commit it evaluated. Comes in two scopes: a **Task Evaluation** (deep: diff narrative, tests, AI findings, QA checklist) and a **Feature Evaluation** (integration-focused: regression, journeys, PRD criteria, refactor opportunities).
_Avoid_: Evaluation plan, eval plan, acceptance eval, review doc

**Review**:
The human activity in the Review column: reading the evaluation, doing QA, and recording a decision. The AI Review step is distinct — it produces the evaluation.

**Decision**:
The recorded outcome of a review: approved or changes requested, with a snapshot of whether QA was complete.
_Avoid_: Approval (as the entity name)

**Notification**:
A typed alert (critical / warning / info) raised by a pipeline skill during execution, consolidated into the evaluation, and shown unread-counted on the card tile until read. Browser push is a delivery mechanism, not this entity.
_Avoid_: Attention flag, flag

**Status** (card lifecycle):
Where a card is in its life: **draft** (shaping material in a feature's Tasks step, not on the board — only tasks), **active** (on the board, in its pipeline), **merged** (terminal for child tasks: branch merged into the feature branch), **done** (terminal for features and standalone tasks: Finalize completed). Drafts that are discarded are hard-deleted, not tombstoned.

**Draft**:
A task card with draft status — inspectable, editable, deletable in the feature's Tasks step before fan-out activates it.
_Avoid_: Draft task as a separate entity from Card

**Step**:
A typed unit of work inside a column — human, AI chat, or AI execution — with status pending / queued / ai-working / needs-user / done. The database stores current step state only; history lives in runs and artifacts.

**Round**:
One pass of a card's rework loop, counted from 0. A partition key on record tables (artifacts, runs, change requests, decisions, notifications), never an entity of its own. A changes-requested decision at round N begets round N+1.

**Rework**:
The loop triggered by a changes-requested decision: a task re-implements against the change requests; a feature re-shapes new draft tasks from them.

**Run**:
One skill invocation by the execution runner, recording status, timestamps, model, tokens, cost, and a pointer to its log file. Session metadata and the eval mini-pipeline display are aggregations of runs.

**Change Request**:
A free-text item raised during review, scoped to a round, moving open → consumed. The open set is collectively the input to the next round. Sources: manual, AI-review finding, refactor opportunity.

**Artifact**:
A file produced by a step, stored in the artifact folder and indexed by a database row holding metadata and a path — never content. Self-describing via frontmatter; lineage recorded as derived-from links.

**Artifact folder**:
Jeeves' own file storage (`data/cards/<cardId>/<round>/`), outside the repository under review. The file-shaped source of truth; SQLite is the index.
_Avoid_: Data dir, jeeves data dir

**Harvest**:
The runner copying worktree-produced artifacts from the host worktree path into the artifact folder (and notifications into the database) before worktree teardown. Exchange sidecars (e.g. `.jeeves/plan.md`) are removed from the worktree after a successful harvest.

**Fan-out**:
Activating a feature's draft tasks into child cards on the board.

**QA gate**:
The Approve-button gating driven by the evaluation's QA checklist. Checkbox state is ephemeral in the parent board's browser-local storage and synchronized with the sandboxed evaluation by validated messages; only the decision's QA-complete snapshot persists.

**Preview**:
A temporary host-process development server for manually testing a card in Human Review at the evaluation's exact Git SHA. The preview manager recreates a worktree at that SHA, runs Jeeves-owned setup/dev commands as a child process on an allocated port, and probes readiness over HTTP. One preview is lazy-retained at a time; its process tree and worktree are removed on Stop or review exit. Launch policy (`preview_config`: setup/dev commands, port, readiness, env allowlist) belongs to the project in Jeeves, never to the reviewed branch.

**Blocker**:
A card that must merge before another may start. Stored as card-to-card edges.
_Avoid_: Dependency (ambiguous with package dependencies)

**Project**:
A target repository jeeves works on. Every card belongs to exactly one project. The project owns its explicit local default branch and trusted preview configuration.

**Manifest**:
The per-card `manifest.json` in the artifact folder — a regenerable projection of the database index that agent runs read instead of the database.
