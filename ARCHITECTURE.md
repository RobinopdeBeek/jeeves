# Jeeves — Architecture

The structural source of truth for jeeves: how the system is shaped, what it runs on, and where the seams are. Keep this file high-altitude — update it only when structure changes (new process, new deep module, new store boundary, stack choice). Implementation detail belongs in code, ADRs, and `CONTEXT.md`.

> Domain vocabulary → [`CONTEXT.md`](./CONTEXT.md) · Decision records → [`docs/adr/`](./docs/adr/) · Column-level schemas → `server/db/schema.ts` (code is the source of truth for columns)

Jeeves is a personal workflow board that runs an AI-assisted development pipeline: cards move through phase columns, typed steps run inside each column, and artifacts accumulate per step while the human reviews asynchronously. The board is a **pipeline monitor and async review tool** — while the AI builds vertical slices autonomously, the human is defining the next feature and steps in only where judgment is needed.

---

## Overall architecture

A single Node.js process orchestrates everything and owns the queue, chat sessions, worktrees, and preview slot as in-memory state ([ADR 0013](./docs/adr/0013-one-long-lived-process-owns-orchestration-state.md)): deep modules carry behaviour; HTTP routes and the React client are thin adapters ([ADR 0006](./docs/adr/0006-thin-adapters-over-five-deep-modules.md)). Workflow is code (pipelines are TypeScript constants), state is data (SQLite), and file-shaped output lives in the project's artifact folder with SQLite as its index ([ADR 0002](./docs/adr/0002-workflow-is-code-state-is-data.md), [ADR 0003](./docs/adr/0003-sqlite-is-the-index-files-are-the-truth.md)). Each target repository owns a gitignored **project store** at `<repo>/.jeeves/` ([ADR 0011](./docs/adr/0011-project-store-in-target-repo-gitignored.md)). Reasoning for these choices lives in [`docs/adr/`](./docs/adr/).

### System context (runtime view)

```
Laptop (always on)
│
├── Hono server — node server/index.ts        (the one long-lived process)
│     ├── HTTP / SSE   → React board UI + REST + live board updates
│     ├── /artifacts   → project-store files (eval iframe, screenshots)
│     ├── /ws/chat     → AcpBridge ⇄ `agent acp`          [AI Chat]
│     ├── queue        → ExecutionEngine → @cursor/sdk    [AI Execution]
│     └── preview      → host-process preview             [Human Review]
│
├── Jeeves app repo — server, client, prompts (no per-project board state)
├── Target repo(s) — application source; git-clean
│     └── .jeeves/ — project store (jeeves.db, data/, worktrees/)
└── Tailscale — private access from other devices
```

What crosses each boundary:

- **Browser ⇄ server:** REST for CRUD and transitions; SSE for board state; WebSocket for streaming AI chat; HTTP for root-confined artifact files. Evaluation HTML runs in a sandboxed iframe; QA checkbox state stays browser-local and syncs via validated `postMessage`.
- **Server ⇄ ACP agent:** server spawns `agent acp`, pipes JSON-RPC, and projects events into AI SDK `UIMessage` parts inside `AcpBridge`. Host-written chat artifacts land in the project store.
- **Server ⇄ agent worktree:** `@cursor/sdk` local runs in a self-managed worktree with no DB access. Agents write short-lived **exchange files**; the host harvests them into `<repo>/.jeeves/data/` before teardown ([ADR 0010](./docs/adr/0010-self-managed-worktrees-cursor-sdk.md)).
- **Worktree ⇄ target repo:** each run uses a fresh worktree on one durable card branch; bases are recorded by SHA, never inferred from the host checkout.
- **Preview ⇄ target repo:** Human Review recreates the evaluated `git_sha` and runs Jeeves-owned project commands as a host child process (one lazy-retained slot).

Migration: copy each target repo (including `.jeeves/`), point Jeeves at `repo_path`, run the same command — no code changes.

---

## Tech stack

| Concern | Choice | Why |
|---|---|---|
| Server | Hono + Node.js | Thin adapter over a long-lived orchestrator ([ADR 0013](./docs/adr/0013-one-long-lived-process-owns-orchestration-state.md)) |
| Database | SQLite via Drizzle | Single-user, zero setup; one `jeeves.db` per project store |
| UI | React + Tailwind + shadcn/ui | Responsive web across devices |
| Execution | Self-managed worktrees + `@cursor/sdk` local | Jeeves owns git lifecycle; agent runs on host ([ADR 0010](./docs/adr/0010-self-managed-worktrees-cursor-sdk.md)) |
| Chat streaming | Vercel AI SDK + assistant-ui | `UIMessage` parts + pre-built chat chrome ([ADR 0008](./docs/adr/0008-ai-sdk-assistant-ui-agent-runner.md)) |
| AI chat transport | Cursor ACP (`agent acp`) | Interactive sessions with codebase context |
| Networking | Tailscale | Private multi-device access |

Chat (ACP) and execution (`@cursor/sdk`) share AI SDK stream types but use different backends ([ADR 0008](./docs/adr/0008-ai-sdk-assistant-ui-agent-runner.md)).

### Non-goals

Deliberately not built (revisit only when the need is real):

- No cloud dependencies — no Supabase, Cloudflare Workers, or deployment pipeline
- No parallel execution — a sequential queue, one run at a time
- No native mobile app — responsive web only
- No custom diff renderer — the evaluation HTML carries its own inline diffs
- No workflow editor — pipelines are code ([ADR 0002](./docs/adr/0002-workflow-is-code-state-is-data.md))
- No prototype step in the pipeline
- No CopilotKit/AG-UI, LangChain/Mastra/CrewAI, or AI Elements — see [ADR 0008](./docs/adr/0008-ai-sdk-assistant-ui-agent-runner.md)
- No direct provider API calls (`generateObject`/`generateText`) — all inference via Cursor
- No HarnessAgent as primary execution path until a Cursor adapter exists and stabilizes
- No Vercel Sandbox/Workflows/AI Gateway hosted infra

---

## Module map

Deep modules hide behaviour behind small seams; routes and React components stay thin adapters. Specs and TDD target these seams ([ADR 0006](./docs/adr/0006-thin-adapters-over-five-deep-modules.md)).

| Module | Lives in | Seam | What it hides |
|---|---|---|---|
| `PipelineEngine` | `server/pipelines.ts` | `advance(card, trigger)` → patches + side-effects | column/step transition rules, auto-advance |
| `CardStore` | `server/cards/` | CRUD, kind decision, fan-out, blockers, derived queries | SQLite card state and derivation rules |
| `ArtifactStore` | `server/artifacts/` | `save` / `harvest` / `list` / serve-path | versioned files, manifests, rounds, lineage |
| `ExecutionEngine` | `server/execution/` | `enqueue` + run events; preview start/stop | worktrees, `AgentRunner`, queue, preview |
| `AcpBridge` | `server/ws/` | push session + `ChatSession` / `openChat` lifecycle | `agent acp`, `UIMessage` projection, warm sessions |
| `ChatThreadStore` | `server/chat-threads/` | Project Chat thread index + transcript load/save | `chat_threads` + `data/chat/` files |
| `CardAttachmentStore` | `server/attachments/` | card Info library CRUD | `card_attachments` + per-card attachment bytes |

Skill prompts under `prompts/execution/` are self-describing; `ExecutionEngine` chooses which runs when. Project Chat thread model/rewind and attachment sidecar rules are ADRs ([0015](./docs/adr/0015-project-chat-threads-and-chatsession.md), [0016](./docs/adr/0016-branchable-transcript-rewind.md), [0017](./docs/adr/0017-chat-attachment-sidecars.md)) — not restated here.

---

## Data model

Entity definitions live in [`CONTEXT.md`](./CONTEXT.md); columns live in `server/db/schema.ts`. Here is only how entities relate.

- A **project** (target repository) owns cards, Project Chat threads, preview config, an explicit local default branch, and a gitignored **project store** at `<repo>/.jeeves/`.
- A **card** is the board entity for features and tasks. Child tasks link via `parent_card_id`; blocked-by is card-to-card edges. Tasks shaping drafts are versioned `tasks-draft` artifacts until fan-out ([ADR 0014](./docs/adr/0014-tasks-drafts-are-versioned-artifacts.md)).
- Card lifecycle `status`: `active` → `merged` (child tasks) or `done` (features / standalone tasks).
- **Card steps** hold mutable *current* step state only.
- History is immutable and round-scoped: **artifacts**, **runs**, **change requests**, **decisions**, **notifications**. A changes-requested decision at round N begets round N+1 ([ADR 0005](./docs/adr/0005-immutability-by-round.md)).
- An **artifact** row is metadata + path; bytes live under the project store's card data tree. Lineage links derived-from (transcript → grill → spec → tasks → plan → impl → eval). Evaluations are not committed to git; `git_sha` pins the reviewed diff.

---

## Primary user flows

Column-level only; step mechanics live in `server/pipelines.ts` and the skill prompts.

### Feature (happy path)

1. Capture in **Backlog**; **"Grill me →"** makes it a feature.
2. **Define Feature**: Grill → Spec → tip `tasks-draft` slices with blocked-by edges.
3. **Fan-out** materializes active child task cards.
4. Each child runs **Implement Task** (Plan → Implement → AI Review), then waits in **Human Review**. Approval merges into the feature tip after a temporary merge check.
5. When all children are merged, the feature advances to **Human Review** with its Feature Evaluation.
6. On approval, **Finalize** opens a PR from the feature branch to `main`; the card is done.

### Standalone task (happy path)

1. Capture in **Backlog**; **"Implement now →"** makes it a standalone task.
2. **Implement Task** runs autonomously (branch from the project default).
3. Approve in **Human Review**; **Finalize** opens the PR; the card is done.

### Rework loop

1. In Human Review the user collects **change requests** and requests changes.
2. Round N+1 starts; open change requests become its input; the old evaluation stays read-only.
3. A **task** returns to Implement Task; a **feature** returns to Tasks for re-shaping, then fan-out as usual.
4. The new round arrives in Human Review as Round N+1.
