# Branches are durable, worktrees are ephemeral

A task's Plan → Implement → AI Review steps run as **separate runs on one durable task branch**, but each run gets a **fresh ephemeral worktree**. The durable hand-offs are explicit: Plan is harvested into the artifact folder and injected into Implement; Implement commits its source changes; AI Review reads that committed branch. No legitimate state lives only in a worktree, so a worktree may be closed after every run and recreated after a process restart without losing context.

Keeping the steps separate preserves per-step progress, retry granularity, the rework loop (`Implement changes →` re-queues `impl` and resets `airev` without re-planning), and per-step artifacts. This is the opposite trade-off from the interactive `/implement` skill, which combines stages because it is a manual development tool rather than an asynchronous monitor.

The branch persists until merge: a child task branch merges into its feature branch on approval; standalone and feature branches persist through Finalize. Branches are named per card (`jeeves/card-<id>`), never per step. A new branch is created from an explicit base ref and recorded base SHA: the project's configured local default branch for features/standalone tasks, or the parent feature branch for child tasks. Jeeves never bases work on the host repository's current checkout and never fetches or updates refs implicitly.

## Run completion and retry

`AgentRunner.run()` owns one temporary worktree and invokes an `ExecutionEngine` finalization callback after the agent exits but before cleanup. The callback harvests declared outputs and enforces step-specific postconditions:

- **Plan:** a non-empty Plan artifact must be harvested; no source changes or commit are required.
- **Implement:** source commits are required and the tree must be clean after declared sidecars are removed.
- **AI Review/evaluation:** declared review artifacts are required; source changes and source commits are forbidden.

Missing or invalid required output fails the run atomically and preserves the worktree for diagnosis. Retry captures the failed worktree's status/diff as a diagnostic artifact, discards the contaminated generated worktree, and recreates a clean one from the recorded pre-run SHA. Harvested sidecars are removed from the target worktree; downstream runs receive canonical artifacts explicitly from `ArtifactStore`.

## Independent child tasks

Explicitly blocked child tasks wait until their blocker is approved and merged. Independent child tasks may reach Human Review concurrently from the same feature baseline. Approval first performs a temporary merge and integration check against the feature branch's current tip. A conflict or failed integration check prevents the merge and returns the task for rework; a clean result merges normally. The Feature Evaluation remains the final assembled integration gate.

## Manual testing in Human Review

Manual testing always targets the evaluation artifact's exact `git_sha`, never an assumed branch tip. The evaluation iframe requests **Start Server** through a validated `postMessage`; the parent binds the action to the displayed card and calls `POST /api/cards/:id/dev-server`.

The preview manager recreates a worktree at that SHA and starts the project's explicitly configured dev server in a **Docker container**, publishing an allocated host port. Preview configuration is Jeeves-owned—not executable configuration from the reviewed branch—and includes the image/Dockerfile, setup command, dev command, container port, readiness path/timeout, and an explicit environment allowlist or separate preview env file. It never inherits Jeeves' ambient environment or credentials.

There is one lazy-retained preview slot initially. The UI moves through **Start Server → Starting… → Open in Browser + Stop Server**; “running” requires a successful readiness check, and failure exposes recent preview logs plus Retry. URLs use the Jeeves/Tailscale hostname, never `127.0.0.1`. Starting another preview confirms replacement. Stop, approval, request changes, card deletion, or Jeeves shutdown removes the container and preview worktree. Labeled orphan containers/worktrees are cleaned on boot.

## Considered options

- **One worktree spanning all three steps** — rejected: once artifacts and commits are the durable hand-offs, a long-lived in-memory workspace adds restart complexity without preserving necessary state.
- **Per-step branches** (the slice-3 stopgap `jeeves/card-<id>/<step>`) — rejected: Plan, Implement, and AI Review belong to one task history.
- **Keep every worktree alive through review** — rejected: idle worktrees consume disk and are reconstructable from branch/SHA.
- **Run previews directly on the host** — rejected: target code and dependency lifecycle scripts are AI-written; Docker preserves the execution trust boundary.
- **Use repository `HEAD` or auto-fetch a base** — rejected: both make branch provenance implicit or mutate refs unexpectedly.

## Consequences

- Slice 4 adopts the per-run `createWorktree()` lifecycle and a pre-cleanup finalization callback, and drops the step suffix from branch names.
- `projects` needs an explicit local `default_branch`; each run/workspace records its resolved `base_sha`.
- Preview configuration and lifecycle are Jeeves-owned project concerns shared with Playwright screenshot capture.
- A preview manager lands with the evaluation/Human Review work; it is not part of slice 4.
