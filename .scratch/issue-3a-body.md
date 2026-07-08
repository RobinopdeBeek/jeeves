## Parent

#5

## What to build

Add the server-side **execution layer** for slice 3: a real autonomous Plan run on standalone tasks, with persisted **runs**, live **SSE** events, and a Sandcastle spike gate before merge.

**Pre-implementation spike (manual gate):** Install `@ai-hero/sandcastle@0.12.0`, scaffold `.sandcastle/` with cursor + docker, set `CURSOR_API_KEY`, run a trivial `hello.txt` spike with explicit `branchStrategy: { type: "branch", branch: "spike/hello" }` (not Docker default `head`). If Docker auth fails on Windows, document `noSandbox()` as the shipped fallback. Record which sandbox path works in the PR.

**AgentRunner seam:** `run(prompt, options): AsyncIterable<RunEvent>` with a **Sandcastle** implementation using `cursor("composer-2.5")`, tracer prompt at `.sandcastle/prompts/slice-3-tracer.md` (`runs.skill = 'slice-3-tracer'`), `cwd` = project target repo, isolated branch per card (e.g. `jeeves/card-<cardId>/plan`). Stream via `logging.onAgentStreamEvent`; persist log to `data/cards/<cardId>/0/run-<runId>.log`.

**ExecutionEngine:** `enqueue(cardId, stepKey)`; FIFO queue (one run at a time); enqueue immediately when `decideKind` sets Plan `queued`; boot scan re-enqueues `queued` steps; on boot orphan `runs` still `running` → `failed` with matching step → `needs-user`. Step transitions for slice 3 Plan only:

```
plan: queued → ai-working → done   (success)
plan: ai-working → needs-user      (failure / interruption)
impl, airev: unchanged pending
```

**Schema:** `runs` table — one row per skill invocation (`running` | `succeeded` | `failed`), `log_path`, nullable token/cost fields.

**HTTP:** `GET /api/events` SSE broadcasting `card.updated`, `run.log`, `run.finished`; run metadata + log tail endpoint for reconnect; `POST /api/cards/:id/steps/plan/retry` (failed or interrupted Plan → `queued` → enqueue).

**Testing:** Vitest at `ExecutionEngine` + **fake** `AgentRunner` (queue FIFO, boot scan, orphan recovery, success/failure transitions, retry, SSE subscriber receives events). Real Sandcastle is manual demo only, not CI.

## Acceptance criteria

- [ ] Sandcastle spike completed; Docker vs `noSandbox` path documented in PR
- [ ] `@ai-hero/sandcastle@0.12.0` in runtime dependencies; `.sandcastle/prompts/slice-3-tracer.md` exists
- [ ] `runs` table migrated; rows created/updated per skill invocation
- [ ] `AgentRunner` interface + Sandcastle implementation with branch worktree isolation
- [ ] `ExecutionEngine` enqueues on decide and boot; FIFO; one run at a time
- [ ] Orphan `running` runs recovered on boot → `failed`, step `needs-user`
- [ ] Successful Plan run → `done`; failed run → `needs-user` + `runs.status = failed`
- [ ] Log files written under `data/cards/<cardId>/0/`
- [ ] `GET /api/events` emits `card.updated`, `run.log`, `run.finished`
- [ ] `POST /api/cards/:id/steps/plan/retry` re-enqueues failed/interrupted Plan
- [ ] Vitest coverage at ExecutionEngine seam with fake runner (no Docker in CI)
- [ ] Slice 2 tests remain green

## Blocked by

None — can start immediately
