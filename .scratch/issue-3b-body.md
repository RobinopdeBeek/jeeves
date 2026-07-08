## Parent

#5

## What to build

Wire **live execution monitoring** on the client for slice 3: board tiles and Plan tab stay current during an autonomous run without page refresh.

**Shared SSE hook:** One `EventSource` on `GET /api/events` per tab. Handle `card.updated`, `run.log`, `run.finished`. On reconnect, re-fetch log tail for the open card.

**Board:** Subscribe while the board page is mounted. On `card.updated`, refresh card list (or patch in place) so tiles show spinner for `ai-working` and queued step semantics without manual refresh. Works on phone over Tailscale.

**Plan tab (StepExecution):** Monospace run log — queued message → live appended lines during `ai-working` → frozen read-only log on complete/fail (prototype Implement-tab behaviour). **Retry** button when latest Plan run `failed` or step `needs-user` after interruption; calls `POST /api/cards/:id/steps/plan/retry`.

Card view filters `run.*` events by `cardId`. Implement and AI Review tabs stay hidden (`pending`) per slice 2 rules.

## Acceptance criteria

- [ ] Board tiles update live during runs (spinner on `ai-working`, no manual refresh)
- [ ] Plan tab streams run log lines over SSE while `ai-working`
- [ ] Completed or failed run leaves a read-only log on the Plan tab
- [ ] Retry button appears after failure/interruption and starts a new run
- [ ] Single `EventSource` shared between board and card view
- [ ] Reconnect recovers log tail without gaps
- [ ] End-to-end demo: **Implement now →** → watch run from board and Plan tab on phone

## Blocked by

#6
