## Parent

#5

## What to build

Add the server-side **execution layer** for slice 3: a real autonomous Plan run on standalone tasks, with persisted **runs**, live **SSE** events, and a Sandcastle spike gate before merge.

**Pre-implementation spike (manual gate, build-time decision):** Install `@ai-hero/sandcastle@0.12.0`, scaffold `.sandcastle/` with cursor + docker, set `CURSOR_API_KEY`, run a trivial `hello.txt` spike with explicit `branchStrategy: { type: "branch", branch: "spike/hello" }` (not Docker default `head`). **If Docker works → ship Docker only** in the runner — no runtime fallback logic. **Only if Docker fails:** verify `noSandbox()` actually works on this host (native Windows Cursor CLI + Sandcastle host git ops are not guaranteed) before adopting it; if both fail, consider running the server under WSL. Record which sandbox provider shipped in the PR. The spike is a one-time gate, not a built-in fallback path.

**AgentRunner seam:** `run(prompt, options): AsyncIterable<RunEvent>` with a **Sandcastle** implementation using `cursor("composer-2.5")` and whichever sandbox provider the spike chose, tracer prompt at `.sandcastle/prompts/slice-3-tracer.md` (`runs.skill = 'slice-3-tracer'`), `cwd` = project target repo, isolated branch per card (e.g. `jeeves/card-<cardId>/plan`). Stream via `logging.onAgentStreamEvent`; persist log to `data/cards/<cardId>/0/run-<runId>.log`. Pass `AbortSignal` through for graceful server shutdown (cancel in-flight Sandcastle run on stop).

**Tracer prompt:** instruct the agent to create `hello.txt` in the repo root **and commit it**. Sandcastle removes worktrees only when clean (uncommitted files are preserved). After a successful run, jeeves deletes the leftover branch.

**Run success (tracer):** `run()` resolves without error **and** `result.commits.length > 0`. A resolved run with zero commits is `failed` (agent did nothing useful). Later real skills will define their own success criteria.

**ExecutionEngine:** `enqueue(cardId, stepKey)`; FIFO queue (one run at a time). **Orchestration:** the `POST /decide` route calls `CardStore.decideKind(...)` then `ExecutionEngine.enqueue(...)` — CardStore must not depend on ExecutionEngine (ADR 0006). Boot hooks run in order: **(1)** orphan `runs` still `running` → `failed`, matching step → `needs-user`; **(2)** scan `card_steps` with status `queued` and enqueue. Step transitions for slice 3 Plan only:

```
plan: queued → ai-working → done   (success)
plan: ai-working → needs-user      (failure / interruption)
impl, airev: unchanged pending
```

**Schema:** `runs` table — one row per skill invocation (`running` | `succeeded` | `failed`), `log_path`, nullable token/cost fields.

**HTTP:** `GET /api/events` SSE broadcasting `card.updated`, `run.log`, `run.finished`; run metadata + log tail endpoint for reconnect; `POST /api/cards/:id/steps/plan/retry` (failed or interrupted Plan → `queued` → enqueue).

**Testing:** Vitest at `ExecutionEngine` + **fake** `AgentRunner` (queue FIFO, boot scan order, orphan recovery, success = commits > 0, failure transitions, retry, SSE subscriber receives events, AbortSignal cancels). Real Sandcastle is manual demo only, not CI.

## Acceptance criteria

- [ ] Sandcastle spike completed; chosen sandbox provider documented in PR (Docker expected; alternatives only if Docker fails verification)
- [ ] `@ai-hero/sandcastle@0.12.0` in runtime dependencies; `.sandcastle/prompts/slice-3-tracer.md` instructs create + commit `hello.txt`
- [ ] `runs` table migrated; rows created/updated per skill invocation
- [ ] `AgentRunner` interface + Sandcastle implementation with branch worktree isolation; leftover branch deleted after success
- [ ] Tracer success requires `result.commits.length > 0`; zero-commit resolved run → `failed`
- [ ] `ExecutionEngine` FIFO; one run at a time; `AbortSignal` wired for shutdown
- [ ] `POST /decide` route orchestrates `decideKind` then `enqueue` — CardStore has no ExecutionEngine dependency
- [ ] Boot: orphan recovery runs before queued-step scan
- [ ] Successful Plan run → `done`; failed run → `needs-user` + `runs.status = failed`
- [ ] Log files written under `data/cards/<cardId>/0/`
- [ ] `GET /api/events` emits `card.updated`, `run.log`, `run.finished`
- [ ] `POST /api/cards/:id/steps/plan/retry` re-enqueues failed/interrupted Plan
- [ ] Vitest coverage at ExecutionEngine seam with fake runner (no Docker in CI)
- [ ] Slice 2 tests remain green

## Blocked by

None — can start immediately
