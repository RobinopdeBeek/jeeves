# Project Structure

> Part of the [Jeeves implementation plan](./jeeves-plan.md).

## Project Structure

The app lives at the **repo root** — this repository is the Jeeves application. Planning
artifacts (`docs/plans/`, `CONTEXT.md`, `prototypes/`, `.agents/`) sit alongside runtime code.
Per-project board state (SQLite, artifacts, worktrees) lives in each **target repository** at
`<repo>/.jeeves/` ([ADR 0011](../adr/0011-project-store-in-target-repo-gitignored.md)), not here.

```
jeeves/                             # repo root — also the app root
├── package.json
├── tsconfig.json
├── drizzle.config.ts
├── CONTEXT.md                      # domain glossary
├── ARCHITECTURE.md
├── docs/
│   ├── adr/
│   └── plans/                      # implementation plan (start at jeeves-plan.md)
│       ├── jeeves-plan.md          # hub: overview + links
│       ├── jeeves-workflow.md
│       ├── jeeves-branching.md
│       ├── jeeves-data-model.md
│       ├── jeeves-artifacts.md
│       ├── jeeves-evaluation.md
│       ├── jeeves-project-structure.md
│       ├── jeeves-build-order.md
│       └── jeeves-skills.md
├── prototypes/                     # throwaway HTML reference (not served in production)
│
├── server/
│   ├── index.ts                    # Hono app entry, serves client + API + WS
│   ├── project-store.ts            # ensure <repo>/.jeeves/ layout + .gitignore entry (planned)
│   ├── db/
│   │   ├── schema.ts               # Drizzle schema (see docs/plans/jeeves-data-model.md)
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
│       ├── to-tasks.md             # writes structured JSON exchange file (harvested + Zod-validated)
│       ├── plan-implementation.md
│       ├── implement-task.md
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

**Target repository layout** (example: `jeeves-test-pantry-checker/`):

```
<target-repo>/
├── src/ …                          # application code (committed)
├── .gitignore                      # includes `.jeeves/` (Jeeves appends on init if missing)
└── .jeeves/                        # gitignored project store (Jeeves-owned)
    ├── jeeves.db
    ├── data/cards/<cardId>/…
    └── worktrees/<cardId>/
```

> Dropped from v1: `/prototype` (no prototype step in the flow) and `improve-architecture.md` as a
> standalone stage (folded into `eval-acceptance.md` as the refactor-opportunities pass).
> Added: `document.md`. Retired: `.sandcastle/` scaffold (Sandcastle + Docker agent path).

