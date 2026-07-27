# One long-lived process owns orchestration state

Jeeves is a long-running local orchestrator that happens to expose a browser UI, not a web application that happens to spawn processes. One Node process owns the sequential execution queue, the `agent acp` subprocesses, the `ChatSessionRegistry` warm slots, git worktrees under `<repo>/.jeeves/worktrees/`, and the single preview child process — as in-memory state with a lifecycle owned by `server/index.ts`, backed by a persistent local filesystem and a single-writer SQLite file per project. Restart recovery, not replication, is how that state survives a crash.

This is the load-bearing decision. The HTTP framework is downstream of it: **Hono + `@hono/node-server`** serves the React bundle, REST, SSE, root-confined artifact files, and the `/ws/chat` upgrade, and does nothing else. Under [ADR 0006](./0006-thin-adapters-over-five-deep-modules.md) every rule lives in the five deep modules, so the web layer is a few hundred lines of adapter and is deliberately cheap to replace. Hono was chosen for being small, WebSocket-native, and unopinionated about deployment; it was not chosen for capabilities the app depends on.

## Why a full-stack framework is the wrong shape

Next.js and TanStack Start optimize for request-scoped rendering and framework-managed deployment. Neither is what this process does. Route handlers shaped for request/response, dev-time module reloading, and multi-worker production all fight a design where exactly one queue and exactly one preview slot exist in memory. Nothing those frameworks are *for* applies to a single-user board reached over Tailscale: no SEO, no cold-start-sensitive SSR, no RSC payoff behind a live SSE feed. Next.js additionally has no first-class WebSocket upgrade — reaching ACP chat means running a custom server, which is the Hono setup with more machinery around it.

The cost paid for this is real and should be named: a split Vite client (`:3940`) and Hono server (`:3939`) requires a dev proxy plus `dev-guard.ts`, `ensure-ports.ts`, and `wait-for-server.ts`. A Vite-based full-stack framework would collapse that into one dev server. That convenience does not outweigh owning the process lifecycle.

## Assumptions this model makes

These hold today and are the things to check before any change of environment or scope:

- **The filesystem is persistent and local.** Worktrees, the artifact tree, and `jeeves.db` all assume it. A VPS with a volume is a no-op migration; ephemeral-disk containers or serverless break the worktree, preview, and database models at once.
- **There is exactly one writer and one process.** `better-sqlite3` is synchronous and single-writer; the queue, warm chat registry, and preview slot are per-process singletons. Two processes would be a correctness bug, not a scaling step.
- **There is exactly one user.** No authentication, no tenancy: every card, artifact path, and preview is implicitly the operator's.
- **The agent runs on the host under the operator's own credentials** — `CURSOR_API_KEY` from repo-root `.env` ([ADR 0010](./0010-self-managed-worktrees-cursor-sdk.md)).

## What would force a revisit

Ordered by how much they hurt, and none of them is a reason to change the HTTP framework:

- **Cloud for a single developer** — no change, provided "cloud" means a Linux box with a persistent volume. A net gain: the SDK's native sandbox becomes available where native Windows cannot offer it.
- **Additional agent harnesses** — below the web layer entirely. `AgentRunner` is already the execution seam, and ACP is a cross-vendor protocol rather than a Cursor one (Claude Code, Codex, OpenCode, Gemini CLI, and Copilot CLI all speak it over stdio), so `AcpBridge` generalizes by making the spawn command and capability set configurable. The real costs are capability divergence across agents and the loss of the single-billing-path assumption that currently justifies banning `generateObject`.
- **Team collaboration** — the first genuine break. Postgres replaces SQLite, which turns `CardStore`'s synchronous methods async and ripples to every caller; the in-memory singletons need a durable queue and a resource pool; identity, per-tenant authorization, and SSE fan-out all become new subsystems.
- **Multi-tenant SaaS** — running untrusted code for strangers, which is the isolation problem [ADR 0010](./0010-self-managed-worktrees-cursor-sdk.md) deliberately walked away from, at higher stakes. Note one seam that would not hold: `ExecutionEngine` owns worktree creation *around* `AgentRunner`, but remote sandboxes make "provision a workspace" and "run in it" a single remote operation, so the boundary would have to move outward.

## Considered options

- **Next.js** — rejected: request-scoped execution model, no first-class WebSocket upgrade, and deployment opinions that conflict with the "copy the repo, run the same command" migration path.
- **TanStack Start** — rejected, but the closer call: Vite-based, so it would have removed the two-port dev scaffolding. Its Nitro server can host a long-lived queue with spawned subprocesses only off the beaten path, and its routing and typed-server-function benefits are near-worthless against a handful of client routes and a CRUD-plus-transitions server surface.
- **Fastify** — rejected narrowly, and the closest substitute. Node-native rather than reached through an adapter, with pino logging and `onClose` lifecycle hooks that suit a process holding worktrees and child processes, plus the plugin ecosystem that team scope would want. Not worth a migration while the web layer stays this thin.
- **Express 5** — rejected: weaker TypeScript story and no built-in WebSocket support, with no advantage over Fastify.
- **Elysia on Bun** — rejected: trades a mature Node ecosystem, `@cursor/sdk`, and git subprocess handling for throughput the app does not need.
- **NestJS** — rejected: its module system is over-structure against five deep modules, though it is a credible destination if multi-tenant scope ever arrives.

## Consequences

- The web layer stays thin enough to remain disposable. A route that accumulates logic is a bug against [ADR 0006](./0006-thin-adapters-over-five-deep-modules.md) and also erodes the escape hatch this decision depends on.
- Restart recovery and boot-time orphan cleanup are load-bearing, not defensive extras: they are how single-process in-memory state is made durable.
- Long-lived-process discipline is a maintenance obligation — watchers scoped to `server/` only, and nothing that writes to the project store may trigger a reload.
- Adopting a second process for any reason (a worker, a second replica) invalidates the queue, warm chat registry, and preview slot simultaneously. It is a re-architecture, not a deployment change.
- The synchronous `CardStore` surface is the concrete lock-in to the single-writer assumption; converting it is the first task of any multi-user move.
