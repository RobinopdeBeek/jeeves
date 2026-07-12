# Jeeves — Architecture

The structural source of truth for jeeves: how the system is shaped, what it runs on, and
where the seams are.

> Domain vocabulary → [`CONTEXT.md`](./CONTEXT.md) · Decision records → [`docs/adr/`](./docs/adr/)
> · Column-level schemas → `server/db/schema.ts` (code is the source of truth for columns)

Jeeves is a personal workflow board that runs an AI-assisted development pipeline: cards move
through phase columns, typed steps run inside each column, and artifacts accumulate per step
while the human reviews asynchronously. The board is a **pipeline monitor and async review
tool** — while the AI builds vertical slices autonomously, the human is defining the next
feature and steps in only where judgment is needed.

---

## Overall architecture

A single Node.js process orchestrates everything: five deep modules carry all behaviour,
and the HTTP routes and React client are thin adapters over them. Workflow is code
(pipelines are TypeScript constants), state is data (SQLite holds per-card state and
round-scoped records), and file-shaped output lives in the artifact folder with SQLite as
its index. The reasoning behind these choices is recorded as decision records in
[`docs/adr/`](./docs/adr/).

### System context (runtime view)

Jeeves' interesting architecture is between processes. One Node.js process orchestrates
external tools around a target repository:

```
Laptop (always on)
│
├── Hono server ─── node server/index.ts        (the one long-lived process)
│     ├── HTTP        → React board UI + REST API + SSE board updates
│     ├── /artifacts  → serves the artifact folder (eval iframe, screenshots)
│     ├── /ws/chat    → AcpBridge ⇄ `agent acp` subprocess (JSON-RPC)   [AI Chat steps]
│     ├── queue       → ExecutionEngine → @cursor/sdk local run          [AI Execution steps]
│     └── preview     → ExecutionEngine → host-process preview           [Human Review testing]
│                          │
│                          ├── self-managed git worktree (WorktreeManager)
│                          ├── fresh per-run worktree of the target repo
│                          └── @cursor/sdk local (composer-2.5) via CURSOR_API_KEY
│
├── SQLite file  +  artifact folder (data/cards/<cardId>/<round>/)
├── Target repo(s) — the projects jeeves works on; stay git-clean, no artifacts committed
└── Tailscale — phone/tablet/other machines reach the board privately
```

What crosses each boundary:

- **Browser ⇄ server:** REST for CRUD, transitions, and preview lifecycle; SSE for live board
  state; WebSocket for streaming AI chat; plain HTTP for root-confined artifact files. The
  evaluation renders in an opaque-origin `sandbox="allow-scripts"` iframe. The parent owns
  browser-local QA state and synchronizes it through source-validated `postMessage`.
- **Server ⇄ ACP agent:** the server spawns `agent acp` per chat session, pipes JSON-RPC, and
  projects events into AI SDK `UIMessage` parts inside `AcpBridge` (including permission
  requests). Host-produced artifacts (grill summary, spec, chat transcripts) are written
  by the server directly into the artifact folder.
- **Server ⇄ agent worktree:** the agent runs in a self-managed git worktree via `@cursor/sdk` local. It has no database access — it reads the injected inputs and the per-card `manifest.json`. Worktree-produced artifacts (Plan, eval HTML, screenshots, structured sidecars) are written to known exchange paths. A generic finalization callback harvests and validates them on the host before teardown; failure preserves diagnostics.
- **Worktree ⇄ target repo:** each run gets a fresh worktree on one durable card branch. Features
  and standalone tasks branch from the project's explicit local default ref; child tasks branch
  from their feature branch. Every base is resolved and recorded by SHA—never inferred from the
  host checkout or updated from remote implicitly.
- **Preview ⇄ target repo:** Human Review testing recreates the exact evaluated `git_sha` in a worktree and runs Jeeves-owned project commands as a host child process with an environment allowlist, readiness check, published port, and one lazy-retained slot.

Migration path: moving to a VPS is "copy the SQLite file + `data/` and run the same
command" — no code changes.

---

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Server | Hono + Node.js | Lightweight, WebSocket-native, runtime-agnostic |
| Database | SQLite via Drizzle (better-sqlite3) | Single-user, zero setup, one file to back up |
| UI | React + Tailwind | Responsive web covers laptop, tablet, and phone |
| Within-column reorder | `@dnd-kit` | Cards move between columns via pipeline logic, not drag — DnD is only for reordering inside a column (Backlog, draft tasks in Define, etc.) |
| Base components | shadcn/ui | Card, Badge, Button, Dialog, Sheet, Progress |
| Icons | Tabler Icons (`@tabler/icons-react`) | Project standard; shadcn `iconLibrary` is `tabler` |
| Markdown editor | MDXEditor | True WYSIWYG that outputs clean markdown |
| Execution engine | Self-managed worktrees + `@cursor/sdk` | Jeeves owns git worktree lifecycle; SDK local runs on host ([ADR 0010](./docs/adr/0010-self-managed-worktrees-cursor-sdk.md)) |
| Agent | `@cursor/sdk` local (`composer-2.5`) | Existing subscription + Cursor's codebase intelligence; no Docker for agent runs |
| Chat state & streaming | Vercel AI SDK 5 (`ai`, `@ai-sdk/react`) | `useChat`, typed `UIMessage` parts, custom transport |
| Chat UI | assistant-ui (`@assistant-ui/react`, `@assistant-ui/react-ai-sdk`) | Pre-built message list, composer, streaming indicators over AI SDK |
| AI chat transport | Cursor ACP bridge | Interactive sessions with full codebase context; ACP projected to `UIMessage` server-side |
| Networking | Tailscale | Private access from any device, zero config |

### Non-goals

Deliberately not built (revisit only when the need is real):

- No cloud dependencies — no Supabase, no Cloudflare Workers, no deployment pipeline
- No parallel execution — a sequential queue, one run at a time
- No native mobile app — responsive web only
- No custom diff renderer — the evaluation HTML carries its own inline diffs
- No workflow editor — pipelines are code
  ([ADR 0002](./docs/adr/0002-workflow-is-code-state-is-data.md))
- No prototype step in the pipeline
- No CopilotKit/AG-UI, LangChain/Mastra/CrewAI, or AI Elements — see
  [ADR 0008](./docs/adr/0008-ai-sdk-assistant-ui-agent-runner.md)
- No direct provider API calls (`generateObject`/`generateText`) — all inference via Cursor
- No HarnessAgent as primary execution path until Cursor adapter exists and API stabilizes
- No Vercel Sandbox/Workflows/AI Gateway hosted infra

---

## AI chat & execution layer

Chat and execution share AI SDK stream types but use different backends today
([ADR 0008](./docs/adr/0008-ai-sdk-assistant-ui-agent-runner.md)):

```
Browser                          Server
  useChat + assistant-ui  ←WS→  AcpBridge  ⇄  agent acp (JSON-RPC)     [AI Chat steps]
  StepExecution (run log)   ←SSE→ ExecutionEngine → AgentRunner           [AI Execution steps]
                                                          └── @cursor/sdk local (composer-2.5)
```

- **Chat:** `AcpBridge` owns the ACP→`UIMessage` projection. The client never sees ACP
  types. Permission requests render as custom message parts; responses flow back through the
  transport. Transcripts serialize as `UIMessage[]` for artifact persistence and replay.
- **Execution:** `AgentRunner` (`run(prompt, options): AsyncIterable<RunEvent>`) is the inner
  seam inside `ExecutionEngine`. One call owns one temporary worktree and invokes a generic
  finalization callback before cleanup so `ExecutionEngine` can harvest and enforce the Plan,
  Implement, or AI Review postcondition. `@cursor/sdk` local is today's implementation; a future
  HarnessAgent adapter would slot in without changing the board, queue, or chat UI.
- **Structured skill outputs:** skills that must return parseable data (e.g. `/to-issues`)
  write JSON to a known worktree path; the runner harvests and validates with Zod on the host,
  with retry on parse failure — not `generateObject` (which would bypass Cursor context and
  add a provider billing path).

---

## Module map

Five deep modules, each a small interface hiding a lot of behaviour. These interfaces are
the **pre-agreed seams**: specs sketch their testing against them and all TDD happens at
them. Everything else (routes, React components) is a thin adapter.

| Module | Lives in | Interface (the seam) | What it hides |
|---|---|---|---|
| `PipelineEngine` | `server/pipelines.ts` | pipeline lookup by `(kind, hasParent)`; `advance(card)` | all column/step transition rules, auto-advance, "workflow is code" |
| `CardStore` | `server/db/` + card logic | CRUD, kind decision, fan-out, blocker edges, derived queries ("X of Y", queue candidates, Round N history) | SQLite/Drizzle, the unified draft/active/merged model, every derivation rule |
| `ArtifactStore` | `server/routes/artifacts.ts` + storage logic | `save`, `harvest(worktree, declarations)`, `list(card)`, serve-path resolution | atomic/versioned files, metadata, root containment, manifest regeneration, lineage, rounds, supersession |
| `ExecutionEngine` | `server/execution/` (`engine.ts`, `runner.ts`, `worktree-manager.ts`, `cursor-sdk-runner.ts`, `run-store.ts`, `events.ts`) | `enqueue(card, step)` + run events; `startPreview(card, gitSha)` / `stopPreview()` | `AgentRunner`, per-run worktrees/finalization, branch strategy, host-process preview lifecycle, sequential queue, blockers, restart recovery, eval sequencing |
| `AcpBridge` | `server/ws/chat.ts` | `openSession(skillPrompt)` → `UIMessage` stream | spawning `agent acp`, ACP→`UIMessage` projection, permission responses, JSON-RPC piping, disconnect/summary handling |

The AI-execution skill prompts live in `prompts/execution/` and are self-describing; the
`ExecutionEngine` decides which skill runs when.

---

## Data model

Entity definitions live in [`CONTEXT.md`](./CONTEXT.md); columns live in
`server/db/schema.ts`. What belongs here is how the entities relate.

- A **project** (a target repository) has many **cards** and owns its explicit local default
  branch plus validated preview configuration; reviewed branches cannot alter launch policy.
- A **card** is the one entity for features, tasks, *and* drafts. A card with a
  `parent_card_id` is a child task of that feature; blocked-by relationships are
  card-to-card edges (`card_blockers`).
- A card's lifecycle is its `status`: `draft` → (fan-out) → `active` → `merged` (child
  tasks) or `done` (features and standalone tasks). Discarded drafts are hard-deleted.
- Each card has **card steps** — one mutable row per step holding *current* state only.
- Everything historical hangs off the card as immutable, round-scoped records:
  **artifacts**, **runs**, **change requests**, **decisions**, and **notifications**. A
  changes-requested decision at round N begets round N+1.
- An **artifact** row is metadata plus a path — the file itself lives in the artifact
  folder (`data/cards/<cardId>/<round>/`). **Artifact lineage** links each artifact to what
  it was derived from (grill → spec → tasks → plan → impl → eval).

---

## Primary user flows

Column-level only; step mechanics live in `server/pipelines.ts` and the skill prompts.

### Feature (happy path)

1. A card is captured in **Backlog**; the user picks **"Grill me →"**, making it a feature.
2. **Define Feature**: a grill chat session, then collaborative spec authoring, then the
   feature is broken into draft tasks with blocked-by edges.
3. **Fan-out**: the drafts activate as child task cards on the board.
4. Each child task runs **Implement Task** (Plan → Implement → AI Review) autonomously,
   then waits in **Human Review** with its Task Evaluation. Blocked tasks wait for blocker
   merge; independent tasks may wait concurrently. Approval validates a temporary merge and
   integration check against the current feature tip before merging and leaving the board.
5. When all children are merged, the feature auto-advances to **Human Review** with its
   Feature Evaluation.
6. On approval, **Finalize** runs Document and Deploy, opening a PR from the feature branch
   to `main`. The card is done.

### Standalone task (happy path)

1. A card is captured in **Backlog**; the user picks **"Implement now →"**.
2. The card runs **Implement Task** autonomously, branching directly off `main`.
3. The user approves in **Human Review**, and **Finalize** opens the PR. The card is done.

In Human Review the evaluation's QA checklist gates the Approve button; only the
`qa_complete` snapshot is persisted, on the decision row.

### Rework loop

1. During Human Review the user collects **change requests** (typed manually or pushed from
   AI-review findings / refactor opportunities) and requests changes instead of approving.
2. The decision starts round N+1; the open change requests are its input and are marked
   consumed. The old evaluation persists read-only.
3. A **task** returns to Implement Task and re-implements against the requests; a
   **feature** returns to the Tasks step, where a breakdown skill drafts new tasks from the
   requests, and the loop continues through fan-out as usual.
4. The new round arrives in Human Review badged Round N+1, with a fresh QA gate.
