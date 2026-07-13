# Branching Strategy

> Part of the [Jeeves implementation plan](./jeeves-plan.md).

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

> Full rationale → [ADR 0009](../adr/0009-branches-durable-worktrees-ephemeral.md).

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
[ADR 0010](../adr/0010-self-managed-worktrees-cursor-sdk.md):

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
