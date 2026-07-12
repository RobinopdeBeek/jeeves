# JEEVES Workflow Board — Implementation Plan

## What We're Building

A personal workflow board that runs a Matt Pocock-inspired development pipeline visually.
Cards move through a small set of **columns**; within a card, typed **steps** run in
sequence (Human, AI Chat, AI Execution), markdown artifacts accumulate per step, and the whole
thing runs from your laptop — accessible from any browser on laptop, tablet, or phone via
Tailscale.

The key insight: the board is a **pipeline monitor and async review tool**. While the AI is
autonomously building vertical slices, you're on another feature — grilling, designing,
prototyping. The board lets you check in, see progress, and step in when human judgment is
needed, without losing context on what you were doing.

---

## Architecture

```
Your laptop (always on, lid open)
  ├── Hono server (Node.js, single process)
  │     ├── Serves React board UI (responsive, all devices)
  │     ├── REST API  →  SQLite via Drizzle
  │     ├── /ws/chat  →  AcpBridge → AI SDK UIMessage stream (AI Chat steps)
  │     └── Execution queue → AgentRunner → @cursor/sdk local (composer-2.5)
  ├── Git (worktree create/remove for agent runs)
  ├── Cursor CLI + CURSOR_API_KEY (ACP chat + SDK local runs)
  └── Your repo (Cursor-indexed, warm)

Tailscale
  └── Phone / tablet / other machines reach the board privately
```

Everything runs with one command: `node server/index.ts`. No cloud dependencies, no
deployment pipeline, no Supabase, no Cloudflare — until you actually need them.

**Migration path (when ready, zero code changes):**
```
Now:    laptop + Tailscale (personal)
Later:  VPS + Tailscale or public URL (team)
Later:  extract client to Cloudflare Pages if needed
```

---

## Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Server | Hono + Node.js | Lightweight, WebSocket native, runtime-agnostic |
| Database | SQLite via Drizzle | Zero setup, single file, familiar ORM |
| UI framework | React + Tailwind | Responsive, no overhead |
| Within-column reorder | `@dnd-kit` | Cards move between columns via pipeline logic, not drag — DnD is only for reordering inside a column (Backlog, draft tasks in Define, etc.) |
| Base components | shadcn/ui | Card, Badge, Button, Dialog, Sheet, Progress |
| Icons | Tabler Icons (`@tabler/icons-react`) | Project standard; shadcn `iconLibrary` is `tabler` |
| Markdown editor | MDXEditor | True WYSIWYG, outputs clean markdown, no format conversion |
| Execution engine | Self-managed worktrees + `@cursor/sdk` | Jeeves owns git worktree lifecycle; SDK local runs on host ([ADR 0010](./docs/adr/0010-self-managed-worktrees-cursor-sdk.md)) |
| Agent | `@cursor/sdk` local (`composer-2.5`) | Your subscription; no Docker for agent runs |
| Chat state & streaming | Vercel AI SDK 5 (`ai`, `@ai-sdk/react`) | `useChat`, typed `UIMessage` parts, custom WebSocket transport |
| Chat UI | assistant-ui (`@assistant-ui/react`, `@assistant-ui/react-ai-sdk`) | Pre-built message list, composer, streaming indicators over AI SDK |
| AI chat transport | Cursor ACP bridge | Interactive sessions with full codebase context; ACP projected to `UIMessage` server-side |
| Networking | Tailscale | Private, zero config, works from phone |

> Full rationale and rejected alternatives → [ADR 0008](./docs/adr/0008-ai-sdk-assistant-ui-agent-runner.md)

---

## AI Chat & Agent Execution

All inference runs on the Cursor subscription — no separate provider API keys.

**Chat (AI Chat steps — Grill, Spec side-chat):** Vercel AI SDK 5 provides message state and
streaming (`useChat`, typed `UIMessage` parts). assistant-ui layers pre-built chat primitives
(message list, composer, streaming indicators) on top. The real work is in `AcpBridge`: it
projects ACP JSON-RPC into `UIMessage` parts server-side and streams them over WebSocket via
a custom `ChatTransport`. ACP vocabulary never reaches the client. Permission requests (ACP
can ask the user to approve actions mid-stream) become custom message parts with a response
path back through the transport. Chat transcripts persist as serialized `UIMessage[]` artifacts.

**Execution (AI Execution steps — Plan, Implement, eval pipeline):** `ExecutionEngine` hides
an `AgentRunner` interface (`run(prompt, options): AsyncIterable<RunEvent>`). Today's
implementation is **`@cursor/sdk` local** — `WorktreeManager` creates an ephemeral worktree per
run on the durable card branch; `CursorSdkAgentRunner` runs `composer-2.5` with `cwd` set to that
worktree. No Docker for agent runs. SDK native sandbox is optional when the host supports it and
unavailable on native Windows ([ADR 0010](./docs/adr/0010-self-managed-worktrees-cursor-sdk.md)).
This keeps the door open to swap in Vercel AI SDK's experimental `HarnessAgent` later without
touching the board, queue, or chat UI. Harness streams project into AI SDK types, so the chat
layer wouldn't change either.

**Structured skill outputs:** skills that must return parseable data (notably `/to-issues`)
write JSON to a known worktree path; the runner harvests it and validates with a Zod schema on
the host, with retry on parse failure. We do not use `generateObject` — that would add a
second billing path and bypass Cursor's codebase context.

**Explicitly not using:** CopilotKit/AG-UI (generative UI framework), LangChain/Mastra/CrewAI
(backend orchestration — Cursor is the agent), AI Elements (redundant with assistant-ui),
Vercel Sandbox/Workflows/AI Gateway (hosted infra), HarnessAgent as primary path until
Cursor is a supported adapter and the API stabilizes.

---

## The Workflow

The board has **5 columns**. A card does **not** visit every column; instead each
card belongs to a **kind**, each kind has its own **pipeline** of columns, and within a column the
card runs a short sequence of typed **steps**. On the board tile those steps show as a segmented
progress bar; in the issue view they show as tabs.

### The 5 columns

| Column | What lives here |
|---|---|
| **Backlog** | Captured ideas, kind not yet decided |
| **Define Feature** | Features only: Grill → Spec → Tasks |
| **Implement Task** | Tasks only: Plan → Implement → AI Review |
| **Human Review** | Your call before merge (per-task or feature-level eval) |
| **Finalize** | Document → Deploy |

### The 2 card kinds and their pipelines

There are two kinds — **feature** and **task** — and a task's pipeline depends on whether it
has a parent feature (child vs standalone is *derived from the parent link*, never stored):

```
feature          Backlog → Define Feature → Human Review → Finalize   (skips Implement)
child task       (Backlog) → Implement Task → Human Review            (no Define, no Finalize)
standalone task  Backlog → Implement Task → Human Review → Finalize   (no Define)
```

- A **feature** is defined, fans out into child tasks, then is reviewed and finalized as a whole.
- A **child task** is generated by a feature's fan-out. It implements one vertical slice and
  merges into the feature branch. It has no Finalize of its own — the feature finalizes.
- A **standalone task** is a one-off change that doesn't need a feature's Define phase. It
  implements, gets reviewed, and finalizes on its own.

### Steps per column

| Column | Steps (type) |
|---|---|
| Backlog | Info · human (title + description) |
| Define Feature | Grill · ai-chat → Spec · ai-chat → Tasks · ai-execution |
| Implement Task | Plan · ai-execution → Implement · ai-execution → AI Review · ai-execution |
| Human Review | Review · human |
| Finalize | Document · ai-execution → Deploy · ai-execution |

### Entry point: Backlog → decide the kind

Every card starts in **Backlog** with just an Info step (title + description) and an undecided
kind. From the Info tab you choose one of two paths:

- **"Grill me →"** — becomes a `feature`, moves to **Define Feature**, starts at the Grill step.
- **"Implement now →"** — becomes a standalone task, moves to **Implement Task**, plan queued.

### Feature path: Define Feature

Three steps, human-collaborative rather than fully autonomous:

1. **Grill** (`ai-chat`) — a `/grill-with-docs` chat session with full codebase context. Surfaces
   constraints and edge cases. Hands off to the Spec step.
2. **Spec** (`ai-chat`) — a WYSIWYG markdown editor for the spec **with an AI side-chat** to draft
   and refine acceptance criteria. The spec's acceptance-criteria checklist authored here is the
   exact list that reappears in the feature-level QA gate later. Hands off to Tasks.
3. **Tasks** (`ai-execution` + human editing, with an AI side-chat) — the feature is broken into
   **end-to-end vertical slices**. Each slice is a real card in **draft status**: inspectable and
   editable (title, description with acceptance criteria and file hints inline, and **"blocked
   by"** relationships between tasks). You add, delete, and re-order before committing; the
   side-chat lets you ask the AI to revise the breakdown (e.g. "make the API slice cover the DST
   edge case too"). Clicking **"Implement →"** fans out: each draft flips to active and appears
   on the board as a child task.

While children run, the feature's Tasks step shows **"Implementing Task X of Y"** and displays the
live child cards inline. When all children are merged, the feature auto-advances to **Human
Review**.

### Task path: Implement Task

Child tasks (and standalone tasks) run three autonomous steps:

1. **Plan** (`ai-execution`) — `/plan-implementation` for the slice.
2. **Implement** (`ai-execution`) — `/implement-issue`; writes code, runs tests, then triggers the
   evaluation pipeline (see [The Evaluation](#the-evaluation)).
3. **AI Review** (`ai-execution`) — `/review` (`thermo-nuclear-review`): categorised findings
   (Critical / Major / Minor / Suggestion).

The task then moves to **Human Review**.

### Human Review (both levels live here)

Human Review is the async review surface. What it shows depends on the card kind:

- **task** (child or standalone) → the **Task Evaluation** (the deep review).
- **feature** → the **Feature Evaluation** (thinner, integration-focused).

Both present the evaluation on the left and a **"Request changes"** sidepanel on the right, plus
a **QA checklist that gates the Approve button** (see next section).

### Finalize

After a feature (or standalone task) is approved, it enters **Finalize**:

1. **Document** (`ai-execution`) — updates docs affected by the change (README sections, ADRs).
2. **Deploy** (`ai-execution`) — `/deploy` opens the PR from the feature branch to `main`.

Child tasks have no Finalize: on approval they merge into the feature branch and leave the
board, but they remain viewable from the parent feature's **Tasks** tab as archived, read-only
artifacts (grouped by round, so prior slices stay traceable after rework).

---

## The Review & Rework Loop

Human Review is not a single "approve" gate — it's a loop, and it works differently for tasks and
features.

### The QA gate

Each evaluation carries a **QA checklist**. The **Approve** button is gated on it:

- QA incomplete → Approve is a plain outline button; clicking it prompts *"QA not complete —
  approve and merge anyway?"*.
- QA complete → Approve becomes a celebratory gradient button.

### Requesting changes

The **"Request changes"** sidepanel holds a list of free-text change requests. You can:

- Add / edit / delete change requests directly.
- Push an **AI-review finding** (task eval) or a **Refactor opportunity** (feature eval) into the
  sidepanel with a `+` button, so surfaced issues become actionable without retyping.

When change requests exist, the primary action changes:

- **Task** (child or standalone) → **"Implement changes →"**
  - Card returns to **Implement Task** for another pass (`impl` re-queued, `airev` reset).
  - The open change requests are injected into the rework implement prompt and marked
    **consumed** (they remain visible on the card as "Changes added later").
  - The Task Evaluation **persists as a read-only artifact** showing an *"Implementing changes…"*
    banner.
  - The QA gate resets; the **rework round counter** increments; the re-run evaluation is badged
    **Round 2**, **Round 3**, …

- **Feature** → **"Create tasks →"**
  - Card returns to **Define Feature → Tasks**. A rework breakdown skill takes the open change
    requests **as one input document** and drafts new tasks from them — merging overlapping
    requests into one task or splitting a big request across slices; the requests are marked
    consumed. You then edit the drafts as usual before fanning out.
  - The prior round's merged tasks remain visible in the Tasks tab, grouped as read-only
    **"Round N"** history.
  - The Feature Evaluation persists as a read-only artifact until the rework is re-reviewed.
  - Rework round counter increments; QA gate resets.

### Approving

With no change requests and QA complete, **Approve** merges:

- **child task** → merges into the feature branch, leaves the board (status → merged).
- **standalone task / feature** → advances to **Finalize** (Document → Deploy).

---

## Branching Strategy

The topology, not the naming convention (which is an implementation detail):

- A **feature** gets its own branch off `main`.
- Each **child task** gets a worktree branch off the feature branch, and merges **back into the
  feature branch** — never directly into `main`. So each child's branch already contains the
  cumulative state of the slices merged before it.
- A **standalone task** branches directly off `main` and opens its own PR at Finalize.
- **Rework rounds** fan out into fresh child branches that don't collide with the original
  round's branches.

```
main
  └── feature branch
        ├── child 1 worktree  ── merges → feature branch
        ├── child 2 worktree  ── merges → feature branch
        └── child 3 worktree  ── merges → feature branch

All children merged ↓

feature branch
  → Human Review (feature-level acceptance eval, incl. refactor opportunities)
  → human approves
  → Finalize: Document → Deploy
  → PR opened: feature branch → main
```

**Where each eval runs:** per-task evals run on the child branch *before* it merges, so each
slice is reviewed against the cumulative state of its predecessors (slices merge sequentially).
The feature-level acceptance eval runs on the feature branch after all slices are merged, in the
Human Review column, just before Finalize.

### Worktree lifecycle: branches are durable, worktrees are ephemeral

> Full rationale → [ADR 0009](./docs/adr/0009-branches-durable-worktrees-ephemeral.md).

The **branch** is durable (it persists until merge); each run's **worktree** is disposable.
Consequences that shape the code:

- **One branch per task, one fresh worktree per run.** Plan → Implement → AI Review are separate
  runs on `jeeves/card-<id>`, never per-step branches. Plan is harvested and injected into
  Implement; Implement commits source changes; AI Review reads that commit. No legitimate state
  lives only in a worktree, so every run closes its worktree and a restart simply recreates it.
- `AgentRunner.run()` invokes an `ExecutionEngine` finalization callback after the agent exits
  but before cleanup. The callback harvests required outputs and enforces the step contract:
  Plan requires an artifact and no source changes; Implement requires commits and a clean tree;
  AI Review requires artifacts and forbids source changes. Failure preserves diagnostics; Retry
  captures the failed diff, discards the contaminated tree, and recreates from the pre-run SHA.
- **Branch bases are explicit.** Projects configure a local `default_branch`; feature and
  standalone branches record its resolved SHA, while child branches record the parent feature
  branch SHA. Jeeves never uses the host checkout and never fetches or updates refs implicitly.

Explicitly blocked child tasks wait for blocker merge. Independent tasks may reach Human Review
concurrently; approval first tests a temporary merge against the feature branch's current tip.
Conflict or integration failure returns the task for rework instead of merging. The Feature
Evaluation remains the final assembled integration gate.

### Testing a card in Human Review

Cards waiting in Human Review are tested at the evaluation's exact `git_sha`, never an assumed
branch tip:

- The evaluation HTML sends a validated **Start Server** request to its parent; the parent binds
  it to the displayed card and calls `POST /api/cards/:id/dev-server`.
- The preview manager recreates a worktree at that SHA and starts a **host-process** dev server
  with an allocated published port (`0.0.0.0` for Tailscale). Jeeves-owned project
  `preview_config` supplies setup/dev commands, port, readiness path/timeout, and an environment
  allowlist — no `image` or `dockerfile` fields; reviewed code cannot change this policy and
  never inherits Jeeves credentials.
- **Lazy-retain, single slot:** Start Server → Starting… → Open in Browser + Stop Server.
  Readiness must pass before Open is offered. Starting another preview confirms replacement;
  Stop, approve, request changes, delete, shutdown, or boot-time orphan cleanup kills the process
  tree and removes the worktree. The URL uses the Jeeves/Tailscale hostname, never `127.0.0.1`.
- Preview configuration and port allocation are shared with Playwright screenshot capture. The
  preview manager lands with evaluation/Human Review work (slice 9), not slice 4.

#### `projects.preview_config` (host-process)

Jeeves-owned JSON on the `projects` row. Implementation in slice 9; schema defined now per
[ADR 0010](./docs/adr/0010-self-managed-worktrees-cursor-sdk.md):

```json
{
  "setupCommand": "npm install",
  "devCommand": "npm run dev",
  "port": 5173,
  "readinessPath": "/",
  "readinessTimeoutMs": 30000,
  "envAllowlist": ["NODE_ENV", "PORT"]
}
```

| Field | Purpose |
|---|---|
| `setupCommand` | One-shot install/build before dev server (optional) |
| `devCommand` | Long-running dev server command |
| `port` | Port the dev server listens on |
| `readinessPath` | HTTP path for readiness probe |
| `readinessTimeoutMs` | Max wait before preview fails |
| `envAllowlist` | Explicit env vars for setup/dev; never inherit ambient secrets |

Docker-isolated preview containers were considered and **rejected for now** — stronger isolation
for AI-written scripts, but would reintroduce Docker as a dev dependency solely for previews. Same
`startPreview` / `stopPreview` seam can adopt Docker later without touching agent execution.

---

## Data Model

> Designed in a grilling session against the prototype; canonical vocabulary lives in
> [`CONTEXT.md`](./CONTEXT.md). Two rules shape everything below:
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
  skill         text         -- e.g. 'implement-issue', 'eval-diff-narrative'
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

Draft tasks are **not** a separate entity: the moment `/to-issues` (or the rework breakdown
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

## Artifact Strategy

Artifacts are the audit trail, the review surface, the hand-off between steps, and a data
source for the UI. Those jobs pull in different directions, so "artifact" is not one thing —
there are four classes, and storage follows from the class:

| Class | Examples | Primary consumer | Wants to be… |
|---|---|---|---|
| **Human/AI prose** | Grill summary, Spec, Plan | Humans + next AI step | Editable, diffable, greppable markdown |
| **Structured state** | Draft cards + blockers, change requests, rework round, decisions, session meta (tokens/cost) | The UI and the queue | Queryable SQLite rows |
| **Composite review doc** | Task Evaluation, Feature Evaluation | Human review; linked from other evaluations | Self-contained HTML pinned to a commit SHA |
| **Media / raw** | Screenshots/GIFs, run logs, chat transcripts (`UIMessage[]`) | Occasional human, gallery | Plain files, possibly large |

### Storage: SQLite index + artifact folder

Two homes, one rule: **SQLite is the index and the source of truth for structured state; the
artifact folder is the source of truth for everything file-shaped.** No blobs in DB columns, and
nothing the UI renders on a card tile is trapped inside markdown/HTML. The user's repo stays
git-clean — no artifacts are committed to it.

**SQLite (Drizzle) — the index + orchestration state.**

- The `artifacts` table holds *metadata + a pointer*, never content (see [Data Model](#data-model)).
- Structured state gets real tables (`change_requests`, `runs`, `decisions`, …), not markdown.
- The board renders tiles, progress bars, notification dots, and gates entirely from the DB —
  it never parses a file to draw a card.

**Artifact folder — all file artifacts, keyed by card.**

```
data/
└── cards/
    └── <cardId>/
        ├── manifest.json            # regenerated projection of the DB index
        └── <round>/
            ├── grill/<artifactId>.md # immutable versions; latest is derived in the index
            ├── spec/<artifactId>.md
            ├── plan/<artifactId>.md
            ├── eval/<artifactId>.html
            ├── screenshots/         # harvested from the worktree
            └── runlog/<runId>.log
```

This folder lives with the jeeves app, **outside the repo under review** — no `.gitignore`
juggling, and the VPS migration is "copy the SQLite file + `data/`". Keep the path configurable.

### Invariants

- **Immutability by round and version.** Re-running a step creates a unique destination (for
  example `plan/<artifactId>.md`), never an overwrite—even within the same round. Known worktree
  paths such as `.jeeves/plan.md` are exchange paths only. Supersession is derived — latest
  `created_at` per `(card, step, round, kind)` wins — not stored as a status flag.
- **`git_sha` on every evaluation.** The evaluation is not committed to the branch, so the SHA
  recorded in its artifact row and HTML metadata is the *only* link back to the exact diff it
  reviewed. Workspace-produced non-evaluation artifacts record HEAD when known.
- **Self-describing files.** Markdown gets YAML frontmatter; self-contained HTML gets equivalent
  `<meta>` elements or an HTML comment so metadata cannot break the document. Metadata includes
  `card_id, step, round, kind, source_skill, derived_from, git_sha, schema_version, created_at`.
- **Root-relative, file-first storage.** Only `ArtifactStore` resolves paths, with containment
  checks. It writes and validates a temporary file, atomically renames it, then inserts the DB
  row. A crash can leave a recoverable self-describing file, never a row pointing at no file.
- **Explicit provenance.** `artifact_lineage` records the real lineage graph
  (grill → spec → tasks → plan → impl → eval) as a join table, queryable in both directions.
  This is the audit trail *and* staleness detection: re-grill and the downstream spec is
  detectably stale (an upstream artifact has a newer version). It's also what lets the Feature
  Evaluation link back to each Task Evaluation.
- **`schema_version`** on artifacts so old evaluations still render after skill prompts evolve.

### Discoverability for the AI

- **Deterministic exchange paths + per-card `manifest.json`** (regenerable from the DB) listing every
  artifact with step, round, kind, path, git_sha. Agents read the manifest first instead
  of globbing; the agent worktree needs no DB access.
- **The runner injects inputs — the AI never hunts.** Each skill invocation gets the resolved
  paths/contents of its inputs explicitly (e.g. `/to-spec` receives the grill summary), resolved
  from the lineage graph by the runner. Discoverability for humans = manifest + frontmatter;
  discoverability for the pipeline = injection.

### Harvesting worktree-produced artifacts

Two production contexts, two flows:

- **Host-produced** (grill summary, spec, chat transcripts, finalized run logs): written or
  finalized by the Hono server. A live log belongs to its mutable `run`; on success or failure
  it is closed and registered as an immutable `runlog` artifact.
- **Worktree-produced** (Plan, eval HTML, screenshots, structured JSON sidecars): generated
  inside the agent's worktree via `@cursor/sdk` local. `AgentRunner` invokes an `ExecutionEngine`
  finalization callback before cleanup; it harvests declared paths from the host worktree path
  (e.g. `.jeeves/plan.md`, `.jeeves/eval.html`, `.jeeves/screenshots/`, `.jeeves/notifications.json`,
  `.jeeves/to-issues.json`), validates them, records metadata, and removes exchange sidecars. A
  missing required artifact fails the run and preserves diagnostics. Structured sidecars are
  Zod-validated before DB mutations.

### Serving artifacts

- Hono serves the artifact folder over HTTP (`/artifacts/<cardId>/…`). The eval iframe loads from
  there, and the screenshot gallery's relative image paths resolve for free — including from
  phone/tablet over Tailscale.
- Database paths are root-relative; callers identify artifacts/cards, never arbitrary filesystem
  paths, and every resolved path is checked to remain inside the artifact root.
- The UI has a subtle **"open artifacts folder"** button per card. Remote (phone/tablet) it
  links to the HTTP directory listing; on the host it can additionally reveal the folder in
  Finder/Explorer.
- The eval iframe uses `sandbox="allow-scripts"`—no `allow-same-origin`—because it renders
  AI-generated HTML.

### QA state: parent localStorage + postMessage, one audit boolean

QA checkbox state is ephemeral UX, not the audit record, so there is **no `qa_items` table**:

- The parent board persists checkbox state in its own `localStorage`, keyed by artifact/card/round,
  and sends initial state to the iframe. The opaque-origin iframe cannot access storage.
- The iframe emits checkbox changes and aggregate status to the board:

```js
parent.postMessage({ type: 'qa-status', finished, checked, total }, '*');
```

- The board validates `event.source` and message shape, binds actions to the displayed card
  instead of trusting a card ID from HTML, persists state, and drives the QA gate live.
- **At decision-time**, the board snapshots one boolean, `qa_complete`, onto the decision row
  in SQLite (for both approve and request-changes). That answers the audit question *"was QA
  complete when this merged?"* without per-item persistence.

---

## The Evaluation

The evaluation is a self-contained HTML report generated by a pipeline of skills
after `/implement-issue`. It's the single artifact that both the AI review (AI Review step)
and the human review (Review column) work from.

> In the prototype the evaluation is rendered **inline** as the Human Review tab so its sections
> are interactive. In production it is a self-contained HTML file harvested into the artifact
> folder (see [Artifact Strategy](#artifact-strategy)), served over HTTP, and rendered in a
> sandboxed iframe (opened via a "View evaluation" affordance). The section content is identical.

### Two levels of evaluation

Evaluation happens at two scopes, and they are deliberately *not* the same review run twice:

**Task Evaluation — the deep review (AI Review + Human Review, on each child branch).**
This is the primary review surface. Because the tasks are vertical slices, each one is
independently end-to-end testable, so each gets the full eval pipeline below: a small focused
diff narrative, the slice's tests, a targeted QA checklist, and a `/thermo-nuclear-review` of
that diff. Small diffs keep the review fast and notifications attributable to a single
unmerged slice you can still reject. This is where the surface-everything work lives.

**Feature Evaluation — the acceptance gate (feature Human Review, on the feature branch).**
After all slices are merged, a *thinner* evaluation validates the assembled feature as a whole.
It deliberately omits the things the Task Evaluations already covered and focuses on what only
emerges once everything is integrated:

| Task Evaluation (child branch) | Feature Evaluation (feature branch) |
|---|---|
| Focused diff narrative for the slice | **No** diff narrative — links back to each Task Evaluation instead |
| The slice's tests | Full regression run across the whole feature |
| QA checklist for that slice's behaviour | End-to-end user journeys that span multiple slices |
| `/thermo-nuclear-review` of that diff | Spec acceptance-criteria checklist |
| Screenshots of that slice | Holistic screenshot walkthrough of the finished feature |
| *(n/a)* | **Refactor opportunities** (formerly `/improve-architecture`) |

**Why both, and not one big evaluation at the end:** collapsing everything into a single
evaluation on the feature branch would throw away the reason we slice vertically. The diff
narrative across all slices becomes an unreadable blob, failures are only found after they've
been built on and merged (the most expensive time), and notifications lose their per-slice
owner. Cumulative per-task testing already catches most integration issues; the feature-level
pass only needs to cover the final slice's integration and holistic spec acceptance.

**Where `/improve-architecture` went.** In v1 this was a standalone stage 10. In v2 it is surfaced
as the **"Refactor opportunities"** section of the Feature Evaluation. Each opportunity has a `+`
button that pushes it into the "Request changes" sidepanel, so architecture improvements become
rework tasks via the normal "Create tasks →" loop rather than a separate autonomous stage.

### Why HTML, not markdown

The evaluation needs interactive checkboxes, syntax-highlighted diffs, a sticky TOC, file links
that open in Cursor, and an embedded screenshot gallery. A self-contained HTML file with inline
CSS handles the document with no dependencies; the parent board provides browser-local checkbox
persistence over `postMessage` so the AI-generated iframe can remain opaque-origin sandboxed. It
opens in any browser and lives in the artifact folder pinned to the reviewed commit by `git_sha`.

### Sections — Task Evaluation

Section names below are canonical (the prototype uses these labels):

**Summary**
What was built, why, and how, plus the **screenshot / GIF gallery** for this slice (captured by
Playwright after dev-server spin-up; falls back to a text description if capture fails). Written
for someone context-switching back after working on a different feature.

**Notifications**
Typed alerts raised by any skill in the pipeline that you must look at before approving — e.g.
Deviation from plan / Test gap / Critical review finding / Unresolved uncertainty. Assembled
last, shown near the top; also inserted into the `notifications` table at harvest (via a
sidecar JSON) to drive the unread dot on the card tile.

**Code changes** *(narrative diff)*
Git diff reordered by architectural layer, not file path: schema → migrations → API → business
logic → UI → tests. Each group has a one-paragraph explanation of what changed and why. Every file
reference is a `cursor://file/path:line` link — one click opens it in Cursor at the right line.

**Tests**
Full test run output. Pass / skip / fail per suite. New tests highlighted. Flags regressions on
touched modules.

**AI review** *(thermo-nuclear-review)*
Categorised findings (Critical / Major / Minor / Suggestion). Each finding can be pushed into the
"Request changes" panel with `+`. Surface-everything pass, not a blocker list.

**QA checklist**
Actionable, behaviour-specific checkbox items persisted by the parent board in browser-local
storage—check them off on your phone as you test. This checklist **gates the Approve button**.

**Metadata** *(session meta)*
Duration, token usage, model, branch, commit, files changed, LOC, estimated cost.

### Sections — Feature Evaluation

**Summary** (with holistic screenshot walkthrough) · **Notifications** (feature-level only) ·
**Tasks** (each merged slice, linking to its own Task Evaluation) · **Refactor opportunities**
(each pushable to change requests) · **Tests — full regression** · **QA — acceptance & journeys**
(Spec acceptance criteria, spec-derived + end-to-end user journeys, behaviour-derived; both feed the
one QA gate) · **Metadata**.

### The evaluation as a skill pipeline

Each section is its own skill, run sequentially after `/implement-issue`:

```
/implement-issue  (code is written, tests pass)
      ↓
/eval-summary          → Summary section (markdown fragment + screenshots)
      ↓
/eval-screenshots      → Playwright captures for the gallery
      ↓
/eval-diff-narrative   → Reads git diff, orders logically, Code-changes section
      ↓
/eval-tests            → Runs test suite, Tests section
      ↓
/thermo-nuclear-review → AI Review section (existing Cursor skill)
      ↓
/eval-qa-plan          → Writes QA checklist section
      ↓
/eval-assemble         → Combines all fragments + consolidates Notifications
                         → writes self-contained HTML file + notifications.json sidecar (in worktree)
                         → runner harvests both into the artifact folder / DB
```

The Feature Evaluation (`/eval-acceptance`) reuses the same skills, feature-scoped:
full regression, cross-slice journeys, spec acceptance checklist, holistic screenshots, and a
refactor-opportunities pass — but **no** diff narrative and **no** thermo-nuclear review (those
live on each child's Task Evaluation, linked from the Tasks section).

**Why this decomposition:**
Each skill has a single focused job. You can re-run any section independently — if the diff
narrative is unclear, re-run just `/eval-diff-narrative` and `/eval-assemble` (a new `runs` row
and a superseding artifact version). Each skill can emit its own notifications, which
`/eval-assemble` consolidates.

### Evaluation visibility on the board

The AI Review step shows a mini-pipeline in the RunLog, not just a single "running" state:

```
Implement Task → AI Review
  ✓ /eval-summary           (12s)
  ✓ /eval-screenshots       (34s)
  ✓ /eval-diff-narrative    (28s)
  ✓ /eval-tests             (15s)
  ⟳ /thermo-nuclear-review  ← running
  ○ /eval-qa-plan
  ○ /eval-assemble
```

When complete, the card advances to Human Review, where the assembled evaluation is the
review surface. This mini-pipeline display is an aggregation of `runs` rows — no separate
progress state is stored.

---

## Project Structure

The app lives at the **repo root** — this repository is jeeves. Planning artifacts
(`jeeves-plan.md`, `CONTEXT.md`, `prototypes/`, `.agents/`) sit alongside runtime code.

```
jeeves/                             # repo root — also the app root
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── CONTEXT.md                      # domain glossary
├── ARCHITECTURE.md
├── jeeves-plan.md
├── docs/adr/
├── prototypes/                     # throwaway HTML reference (not served in production)
│
├── server/
│   ├── index.ts                    # Hono app entry, serves client + API + WS
│   ├── db/
│   │   ├── schema.ts               # Drizzle schema (see Data Model)
│   │   └── index.ts                # db connection (better-sqlite3)
│   ├── pipelines.ts                # per-kind pipeline + step constants (workflow is code)
│   ├── routes/
│   │   ├── cards.ts                # CRUD, kind decision, column/step transitions, fan-out
│   │   ├── artifacts.ts            # read/write per-step markdown + serve artifact folder over HTTP
│   │   ├── runs.ts                 # execution run log
│   │   └── previews.ts             # Start/Stop/status thin adapter
│   ├── ws/
│   │   └── chat.ts                 # AcpBridge: ACP → UIMessage projection, WebSocket transport
│   └── execution/
│       ├── engine.ts               # ExecutionEngine: queue, worktree orchestration, finalization
│       ├── runner.ts               # AgentRunner interface + RunEvent types
│       ├── worktree-manager.ts     # git worktree create/remove, diagnostics, orphan cleanup
│       ├── cursor-sdk-runner.ts    # @cursor/sdk local impl, log tee, cancel, dispose
│       ├── run-store.ts
│       ├── events.ts
│       └── preview-manager.ts      # single-slot host-process preview + readiness/orphan cleanup
│
├── prompts/
│   └── execution/
│       ├── slice-3-tracer.md
│       ├── grill-with-docs.md
│       ├── to-spec.md
│       ├── to-issues.md             # writes structured JSON sidecar (harvested + Zod-validated)
│       ├── plan-implementation.md
│       ├── implement-issue.md
│       ├── eval-summary.md
│       ├── eval-screenshots.md
│       ├── eval-diff-narrative.md
│       ├── eval-tests.md
│       ├── eval-qa-plan.md
│       ├── eval-assemble.md         # produces final HTML, collects Notifications
│       ├── eval-acceptance.md       # feature-level eval, incl. refactor opportunities
│       ├── document.md              # Finalize: update README/ADRs
│       └── deploy.md
│
├── client/
│   ├── index.html
│   ├── main.tsx
│   ├── components/
│   │   ├── Board.tsx               # 5 columns; grouped columns for Implement/Review
│   │   ├── Card.tsx                # title, segmented step progress bar, needs-you border, notification dot
│   │   ├── CardView.tsx            # full-page card view: step tabs + work area + footer
│   │   ├── StepInfo.tsx            # Backlog Info tab + Grill-me / Implement-now decision
│   │   ├── StepGrill.tsx           # assistant-ui chat (useChat + AcpBridge transport)
│   │   ├── StepSpec.tsx             # Spec markdown editor + AI side-chat (reuses chat stack)
│   │   ├── StepTasks.tsx           # draft cards list, blocked-by, fan-out, Round N history
│   │   ├── StepExecution.tsx       # live RunLog + mini eval pipeline progress (Plan/Impl/AIReview)
│   │   ├── ReviewTask.tsx          # Task Evaluation + Request-changes panel + QA gate
│   │   ├── ReviewFeature.tsx       # Feature Evaluation + Refactor opportunities + QA gate
│   │   └── Evaluation.tsx          # opaque-origin iframe + validated QA/preview messages
│   └── hooks/
│       ├── useBoard.ts             # cards + column/step state, SSE for live updates
│       └── useAcpChat.ts           # useChat (@ai-sdk/react) + custom WebSocket ChatTransport
```

> Dropped from v1: `/prototype` (no prototype step in the flow) and `improve-architecture.md` as a
> standalone stage (folded into `eval-acceptance.md` as the refactor-opportunities pass).
> Added: `document.md`. Retired: `.sandcastle/` scaffold (Sandcastle + Docker agent path).

---

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

Each slice below is one issue-sized tracer bullet. Blockers are noted; slices without a
blocker relationship can be built in parallel or reordered.

1. **Walking skeleton: a card on the board.** Minimal `cards` schema, `CardStore`
   create/list, board with tiles, responsive layout, reachable from the phone over Tailscale.
   *Demo: create a card on your phone, see it appear.*
2. **Kind decision moves a card.** Info tab, "Grill me →" / "Implement now →",
   `PipelineEngine` lookup + `advance`. *Demo: a card walks its pipeline's columns.*
   (Blocked by 1.)
3. **Tracer bullet: one real autonomous run.** *(Done — issue #6; execution path migrating per
   [ADR 0010](./docs/adr/0010-self-managed-worktrees-cursor-sdk.md).)* `ExecutionEngine` in its
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
   local default branch/base SHA. See [ADR 0009](./docs/adr/0009-branches-durable-worktrees-ephemeral.md).
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
7. **Fan-out.** `/to-issues` writes a structured JSON sidecar in the worktree (vertical
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
    [Key Prompt Engineering Investment](#key-prompt-engineering-investment)) and wired in
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

1. **Grilling** — done: this plan plus [`CONTEXT.md`](./CONTEXT.md) are its artifacts.
2. **`/to-spec`** per slice group — each spec confirms its testing seams against the module
   map above.
3. **`/to-issues`** — produces roughly the slice sequence above as tracer-bullet issues with
   blocked-by edges.
4. **`/implement` with `/tdd`** — red → green at the pre-agreed seams (the module
   interfaces), one slice at a time.
5. **`/code-review`** against the merge-base — Standards axis + Spec axis (the spec).

Every rough edge found in the skills while building jeeves is dogfooding feedback for the
pipeline jeeves will run.

---

## Key Prompt Engineering Investment

The quality of the entire system depends on these prompts. Prioritise in this order:

1. `/eval-diff-narrative` — hardest to get right, highest value for review speed
2. `/eval-qa-plan` — must be specific and actionable, not generic
3. `/thermo-nuclear-review` — already exists in Cursor, wire it in
4. `/to-issues` — quality here determines whether child cards are truly independent slices;
   output is a harvested JSON sidecar validated with Zod, not free-form markdown to parse
5. `/eval-assemble` — notification consolidation logic is subtle, test carefully
6. `/eval-acceptance` — feature-level scoping + refactor opportunities without re-reviewing slices

Each prompt should be developed and tested independently before being wired into the
pipeline. Run it manually against a real recent PR or diff to validate output quality before
trusting it to run automatically.

---

## Resolved: execution runtime (slice 3 → ADR 0010)

**Decision:** replace Sandcastle + Docker agent execution with **self-managed git worktrees** +
**`@cursor/sdk` local**. No Docker for agent runs. Supersedes the slice-3 Docker-only gate.

**Verified on this host (`.scratch/spike-sdk-worktree.ts`, `npm run spike:sdk`):**

- `WorktreeManager` pattern: `git worktree add -B …` / `remove --force`, isolation from host checkout
- `@cursor/sdk` local with `composer-2.5`, `CURSOR_API_KEY` from repo-root `.env`
- Log streaming via `run.stream()` tee to file; uncommitted `.jeeves/plan.md` harvest on host path
- Cancel via `run.cancel()`; dispose treats `[canceled]` as success
- SDK native sandbox **unavailable** on native Windows — runs proceed without `sandboxOptions.enabled`

**Verdict:** PARTIAL GO (worktree + run + cancel pass; sandbox probe fails on Windows).

**One-time setup on a fresh machine:**

```bash
# Git + CURSOR_API_KEY in repo-root .env — no Docker Desktop required
npm run spike:sdk              # full regression gate
npm run spike:sdk -- --phase run   # plan harvest smoke only
```

See [ADR 0010](./docs/adr/0010-self-managed-worktrees-cursor-sdk.md) for preview policy and
`preview_config` schema.

---

## What We're Explicitly NOT Building

- Multica fork
- Supabase (add later if collaboration is needed)
- Cloudflare Workers (add later if needed)
- Parallel execution (sequential queue is enough to start)
- Native mobile app (responsive web covers phone and tablet)
- Custom diff renderer (eval-assemble generates HTML with inline diffs)
- A `/prototype` step (dropped from the flow)
- CopilotKit/AG-UI, LangChain/Mastra/CrewAI, AI Elements (see
  [ADR 0008](./docs/adr/0008-ai-sdk-assistant-ui-agent-runner.md))
- Direct provider API calls (`generateObject`/`generateText`) — all inference via Cursor
- HarnessAgent as primary execution path until Cursor adapter exists
- Vercel Sandbox/Workflows/AI Gateway hosted infra

---

## Open Questions (revisit later)

1. **Data model redesign** — *resolved:* see [Data Model](#data-model); vocabulary in
   [`CONTEXT.md`](./CONTEXT.md)
2. **Cursor Docker auth / execution runtime** — *resolved:* Sandcastle + Docker superseded by
   self-managed worktrees + `@cursor/sdk` local ([ADR 0010](./docs/adr/0010-self-managed-worktrees-cursor-sdk.md)).
   Requires git + `CURSOR_API_KEY`; no Docker Desktop for agent runs.
3. **Parallel child card execution** — add concurrency to queue once sequential is proven
4. **Playwright screenshot capture** — *resolved for sequential v1:* reuse the Jeeves-owned
   host-process `preview_config`, readiness check, and port allocator used by manual Start Server.
   Revisit only when parallel execution requires a port pool.
5. **Colleague access** — move server to VPS, no code changes required
6. **Feature auto-advance trigger** — needs an "all children merged" event; implement as a check in
   the queue after each child card's Human Review approval
7. **Evaluation: inline vs standalone HTML** — *resolved:* the prototype inlines it; production
   generates a self-contained HTML file, harvested into the artifact folder and rendered in a
   `sandbox="allow-scripts"` iframe; the parent owns browser-local QA state and validates
   `postMessage` (see [Artifact Strategy](#artifact-strategy)).
8. **Worktree lifecycle + manual testing** — *resolved:* branches are durable, worktrees are
   fresh per run and recreated from explicit refs/SHAs; Implement steps share a task branch and
   explicit artifacts, not a physical worktree. Human Review previews recreate the exact evaluated
   SHA and run with Jeeves-owned host-process configuration (see
   [Worktree lifecycle](#worktree-lifecycle-branches-are-durable-worktrees-are-ephemeral),
   [Testing a card in Human Review](#testing-a-card-in-human-review), and
   [ADR 0009](./docs/adr/0009-branches-durable-worktrees-ephemeral.md)).
