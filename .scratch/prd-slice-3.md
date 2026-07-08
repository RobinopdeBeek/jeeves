# Slice 3: Tracer bullet — one real autonomous run

## Problem Statement

Slice 2 leaves standalone tasks on the Implement column with Plan `queued`, but nothing consumes that queue — the board is a pipeline monitor that cannot yet run work. The plan's first technical unknown (Cursor auth inside Sandcastle's Docker sandbox) is unresolved, and there is no proof that jeeves can orchestrate a real agent end-to-end: persist a **run**, stream a **run log** live to the card view, and reflect **ai-working** on the board tile.

Without slice 3, "Implement now →" is a dead end and every later execution slice (artifact harvest, full task pipeline, evaluation) is built on faith.

## Solution

Add **ExecutionEngine** in its thinnest form: a sequential queue that picks up Plan `queued` on standalone tasks, runs a tracer skill via **Sandcastle** + **`cursor("composer-2.5")`**, writes a **`runs`** row, streams log lines over **SSE**, and updates **card step** status. The demo path: create a card → **Implement now →** → watch Plan go `ai-working`, see the run log on the Plan tab, succeed with Plan `done` (Implement and AI Review stay `pending`).

Resolve **Cursor in Docker** with a **pre-implementation spike** before wiring the engine. The spike is a **build-time decision**: if Docker works, ship Docker only — no runtime fallback. Only if Docker fails must the fallback leg (`noSandbox()` or WSL) be verified before adoption.

## User Stories

1. As a user who chose **Implement now →**, I want Plan to start running automatically without a manual trigger, so that autonomous execution feels immediate after the kind decision.
2. As a user who chose **Implement now →**, I want the board tile to show a spinner while Plan is `ai-working`, so that I can monitor progress without opening the card (prototype behaviour).
3. As a user on the Plan tab while a run is active, I want a monospace run log that appends lines as the agent works, so that I can watch execution like the prototype's Implement tab.
4. As a user on the Plan tab after a successful run, I want the completed run log to remain visible (read-only), so that I have a record of what happened.
5. As a user on the board during a run, I want card/step updates to arrive without refreshing the page, so that the tile spinner and step bar stay current.
6. As a user with two standalone cards both queued, I want only one run at a time with the second card's Plan staying `queued` until the first finishes, so that Sandcastle/Cursor load stays predictable.
7. As a user whose run failed (agent error, Docker auth, timeout), I want Plan to land on `needs-user` with the error visible in the run log, so that the blue needs-you border tells me to intervene.
8. As a user after a failed or interrupted run, I want a **Retry** control on the Plan tab, so that I can re-enqueue without restarting the server.
9. As a user retrying a failed Plan step, I want a new **run** to start and the step to return to `ai-working`, so that retries are explicit attempts with their own log.
10. As a developer, I want a **`runs`** table with one row per skill invocation (`running` / `succeeded` / `failed`), so that execution history is queryable before the full artifact system exists.
11. As a developer, I want each run's log file at `data/cards/<cardId>/0/run-<runId>.log`, so that slice 4's artifact layout is established early.
12. As a developer, I want the tracer skill in `.sandcastle/prompts/slice-3-tracer.md` with `runs.skill = 'slice-3-tracer'`, so that prompt-file wiring matches future real skills.
13. As a developer, I want Sandcastle to run against the project's **target repo** in an isolated **branch** worktree (not default `head`), so that `hello.txt` never lands on the host working tree root.
14. As a developer, I want the tracer to commit `hello.txt` so Sandcastle can remove the clean worktree and jeeves can delete the leftover branch, so that the jeeves repo stays clean when the target repo is jeeves itself.
15. As a developer, I want `enqueue` called immediately after `decideKind` sets Plan `queued` (orchestrated in the route, not inside CardStore), and queued steps re-enqueued on server boot after orphan recovery, so that restarts do not strand cards forever.
16. As a developer, I want orphaned `runs` still `running` after a crash marked `failed` with Plan → `needs-user`, so that no card stays stuck `ai-working` silently.
17. As a developer, I want a single SSE endpoint (`GET /api/events`) broadcasting `card.updated`, `run.log`, and `run.finished`, so that board and card view share one live channel.
18. As a developer, I want `POST /api/cards/:id/steps/plan/retry` to re-queue a failed or interrupted Plan step, so that restart semantics are explicit and testable.
19. As a developer, I want **`AgentRunner`** as the inner seam (`run(prompt, options): AsyncIterable<RunEvent>`) with a Sandcastle implementation, so that a future HarnessAgent adapter can swap without touching the queue or UI.
20. As a developer, I want Vitest coverage at the **ExecutionEngine** + fake **AgentRunner** seam (queue FIFO, boot scan, orphan recovery, retry, SSE emission), so that CI does not depend on Docker/Cursor.
21. As a developer, I want the Docker spike documented as a manual gate before merge (with fallback paths verified only if Docker fails), so that the plan's first unknown is resolved in this slice not five slices later.
22. As a developer, I want tracer run success defined as resolved with at least one commit, so that a no-op agent is not marked succeeded.
23. As a developer, I want in-flight runs cancellable via `AbortSignal` on server shutdown, so that orphaned subprocesses do not linger.
24. As a user on mobile (Tailscale), I want the same live run experience when viewing the board or card, so that slice 1's remote-access story extends to execution monitoring.

## Implementation Decisions

### Testing seams (proposed — one primary seam)

**Primary seam: `ExecutionEngine` + `AgentRunner` interface.**

- All automated tests use a **fake `AgentRunner`** that yields scripted `RunEvent`s (log lines, success/failure). Assert external behaviour: step status transitions, `runs` rows, queue order, orphan recovery, retry route, SSE payloads.
- **`CardStore`** is exercised only where the engine updates steps (or via a thin callback the tests stub) — not re-tested for kind decision logic from slice 2.
- **Sandcastle + real Cursor** is manual demo only (post-spike), not CI.
- React client: no component unit tests unless a regression guard is needed; behaviour verified via the SSE + API contract.

This matches ADR 0006 (TDD at pre-agreed module seams). The HTTP routes and React panels remain thin adapters.

### Modules

- **ExecutionEngine** (new): `enqueue(cardId, stepKey)`; sequential FIFO queue by enqueue time; one run at a time; `AbortSignal` for graceful shutdown; boot hooks in order — **(1)** orphan `runs` with status `running` → `failed`, matching step → `needs-user`; **(2)** scan `card_steps` with status `queued` and enqueue; emits SSE events during runs.
- **AgentRunner** (new interface + types): `RunEvent` stream (at minimum log lines and terminal success/failure with optional token usage). **SandcastleAgentRunner** implementation wraps `@ai-hero/sandcastle` `run()` with `cursor("composer-2.5")` and the sandbox provider chosen at spike time.
- **CardStore** (extended minimally): methods the engine needs to transition step status (`queued` → `ai-working` → `done` / `needs-user`), read project `repoPath`, and load card context. **Does not** call ExecutionEngine — the `POST /decide` route orchestrates `decideKind` then `enqueue` (ADR 0006).
- **Runs persistence** (new): Drizzle `runs` table + small store or methods on CardStore — create run at start, update on finish, link `log_path`.
- **SSE broadcaster** (new): in-process pub/sub subscribed by `GET /api/events`; reconnect-friendly (client may re-fetch log tail on gap).
- **Card routes** (extended): `POST /api/cards/:id/steps/:stepKey/retry` — for slice 3, only `plan` is exercised; validates latest run failed or step `needs-user` after interruption → `queued` → enqueue.
- **Server bootstrap** (extended): start ExecutionEngine queue processor and boot hooks on listen.
- **React client** (extended): `StepExecution` shows live run log + Retry when appropriate; shared `EventSource` hook for board + card view; board tile reflects `ai-working` / `queued` from `card.updated` events.

### Pre-implementation spike (gate)

Before building the engine, run the plan's Sandcastle spike:

1. Install `@ai-hero/sandcastle@0.12.0`.
2. `npx @ai-hero/sandcastle init` with **cursor** + **docker** (use an issue tracker that allows image build — `custom` skips build; run `sandcastle docker build-image` manually if needed).
3. Set `CURSOR_API_KEY` in `.sandcastle/.env`.
4. Trivial `run()` with explicit `branchStrategy: { type: "branch", branch: "spike/hello" }` and a create-and-commit-`hello.txt` prompt.
5. **If Docker works → ship Docker only** in the runner (no runtime fallback).
6. **Only if Docker fails:** verify `noSandbox()` on this host before adopting; if that also fails, consider WSL.

Record which sandbox provider shipped in the PR. This is a build-time choice, not a runtime fallback.

### Sandcastle integration details

- Package: `@ai-hero/sandcastle` **0.12.0**; sandbox import from whichever provider the spike chose (expected: `@ai-hero/sandcastle/sandboxes/docker`).
- Agent: `cursor("composer-2.5")` per jeeves plan (README documents this model string).
- **Do not use Docker default `head` branch strategy** — bind-mount default writes directly to host cwd. Use explicit branch strategy, e.g. `jeeves/card-<cardId>/plan`, so work is isolated in a worktree.
- `cwd` on `run()` = project target repo path; `promptFile` resolves against server process cwd (jeeves app root) pointing at `.sandcastle/prompts/slice-3-tracer.md`.
- Live log: Sandcastle `logging.onAgentStreamEvent` → map `text` / `toolCall` / `raw` events to SSE `run.log` lines; also `logging.type: "file"` to the jeeves log path.
- Cursor limitations: no `maxRetries`, no `resumeSession` — do not use structured-output retry loops with this provider.
- Worktree cleanup: tracer prompt requires a **commit** so Sandcastle removes the clean worktree; jeeves deletes the leftover branch after success. Dirty worktrees (failed runs) may be preserved for debugging.
- Run success (tracer): `run()` resolves **and** `result.commits.length > 0`. Zero commits → `failed`.

### Schema: `runs`

One row per skill invocation (not per step):

- `id`, `card_id`, `step_key`, `round` (default `0`), `skill` (e.g. `slice-3-tracer`)
- `status`: `running` | `succeeded` | `failed`
- `started_at`, `finished_at`
- `model` (nullable), `tokens_in`, `tokens_out`, `cost` (nullable — populate when Sandcastle returns usage)
- `error` (nullable short message)
- `log_path` (into `data/cards/<cardId>/0/`)

No `failed` status on `card_steps` — failure is `needs-user` on the step + `failed` on the run row. UI distinguishes failure vs normal `needs-user` by checking latest run status.

### Step transitions (slice 3 scope — Plan only)

**Trigger:** `decideKind` standalone path sets `plan: queued`; the decide route calls `enqueue` immediately after. On boot: orphan recovery first, then scan all `queued` steps.

**Happy path:**

```
plan: queued → ai-working → done
impl, airev: remain pending
```

**Failure / interruption:**

```
plan: ai-working → needs-user
runs.status: failed
```

**Retry:** `POST .../steps/plan/retry` → `plan: queued` → enqueue → `ai-working` → …

**Queue:** second card stays `plan: queued` until first run completes (FIFO by enqueue time). Board segmented bar may show "(in queue)" semantics for queued steps (prototype).

### SSE contract

Single stream: `GET /api/events`

| Event | Payload (conceptual) |
|---|---|
| `card.updated` | Card id + enriched steps + column — board tiles refresh |
| `run.log` | `runId`, `cardId`, `line` (or formatted chunk) |
| `run.finished` | `runId`, `cardId`, `status`, optional `error` |

Client: one `EventSource` per tab; card view filters `run.*` by `cardId`; on reconnect, fetch latest log tail for open card.

### API additions

- `GET /api/events` — SSE
- `GET /api/cards/:id/runs` or `GET /api/runs/:id` — fetch run metadata + log tail for reconnect (exact shape at implementer's discretion)
- `POST /api/cards/:id/steps/plan/retry` — re-enqueue Plan

### UI behaviour (prototype layout/behaviour; styling secondary)

- **Plan tab** uses the run-log panel pattern (like prototype Implement tab): queued message → live stream → frozen log on complete/fail.
- **Spinner** on board tile while any step in the current column is `ai-working`.
- **Needs-you border** when Plan is `needs-user` after failure (existing slice 2 rule).
- **Retry** button visible when latest Plan run `failed` or step `needs-user` after interruption.
- Implement and AI Review tabs remain hidden (`pending`) per slice 2 rules.

### Tracer prompt

`.sandcastle/prompts/slice-3-tracer.md` — instruct agent to create `hello.txt` in the repo root **and commit it** (minimal proof of autonomous execution; enables clean worktree teardown). `runs.skill = 'slice-3-tracer'`.

### Dependency placement

`@ai-hero/sandcastle` is a **runtime** dependency (server executes it), not dev-only.

## Testing Decisions

### What makes a good test

Test **external behaviour at the ExecutionEngine / AgentRunner seam**: given a queued Plan step, when the fake runner emits events, the step ends `done` or `needs-user`, a `runs` row exists with correct status, log path is set, and SSE subscribers receive the expected event sequence. Do not assert Sandcastle internals or Docker behaviour in CI.

### Modules tested

- **ExecutionEngine** (primary) with fake **AgentRunner**
- **Retry route** — optional thin HTTP test for status codes if route layer adds validation; not required if engine coverage is thorough
- **CardStore** — only new step-transition helpers if extracted; slice 2 tests remain green

### Cases to cover

- Decide route enqueues after `decideKind` → Plan becomes `ai-working` when runner starts
- FIFO: two queued cards → second waits
- Boot: orphan recovery runs before queued-step scan
- Orphan `running` run on boot → `failed`, step `needs-user`
- Successful run (commits > 0) → Plan `done`, `impl`/`airev` unchanged `pending`
- Failed runner or zero commits → Plan `needs-user`, run `failed`
- AbortSignal cancels in-flight run on shutdown
- Retry → new run row, step re-executes
- SSE: at least one test that subscriber receives `run.log` and `card.updated` (in-process listener)

### Prior art

- `server/cards/store.test.ts` — Vitest, in-memory SQLite, store seam pattern from slices 1–2

### Manual gate (not CI)

Sandcastle Docker spike + demo: **Implement now →** on phone over Tailscale, watch hello.txt run complete.

## Out of Scope

- Plan → Implement → AI Review sequencing (slice 8)
- Blocker-aware queue (slice 8)
- Branch strategy onto feature branch / child tasks (slice 7–8)
- **ArtifactStore** harvest, serve, `artifacts` table (slice 4) — only log path convention
- Real `plan-implementation.md` skill (slice 8)
- AcpBridge / Grill chat (slice 5)
- Evaluation, Human Review, Approve, rework (slices 9+)
- Full "Restart step" for arbitrary steps (slice 14) — only minimal Plan Retry here
- `failed` as a `card_steps` status enum value
- Auto-queue Implement after Plan succeeds
- Parallel execution (multiple simultaneous Sandcastle runs)
- Tokens/cost accuracy requirements — nullable fields OK if Sandcastle omits usage for cursor
- Polling-based live updates (SSE is in scope for this slice)

## Further Notes

- Blocked by slice 2 (kind decision + Plan `queued` shell) — assumed complete.
- Domain vocabulary: **run**, **step**, **card**, **queued**, **round** — see `CONTEXT.md`.
- ADR 0006: thin adapters; ADR 0008: execution via Sandcastle + cursor today, `AgentRunner` as inner seam.
- **Sandcastle 0.12.0 research highlights:** `logging.onAgentStreamEvent` is the live-stream hook; Docker default branch strategy is `head` (must override); Cursor auth in Docker uses `CURSOR_API_KEY`; cursor does not support session resume or `maxRetries`; Sandcastle preserves dirty worktrees (tracer must commit).
- Demo: standalone path only in this slice — feature / Grill path unchanged.
- After spike, note which sandbox provider shipped in the PR description (Docker expected).
