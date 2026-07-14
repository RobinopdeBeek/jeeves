# Self-managed worktrees and @cursor/sdk for agent execution

Jeeves replaces Sandcastle + Docker as the autonomous execution path. **Jeeves owns git worktree lifecycle** (`WorktreeManager`: create at recorded base SHA, remove after run, capture diagnostics, boot-time orphan cleanup). **`@cursor/sdk` local** is the `AgentRunner` implementation — `Agent.create({ local: { cwd: worktreePath, settingSources: [] } })` with `composer-2.5`. **No Docker for agent runs.** Sandcastle's container sandbox, image build, and `logging.type: "file"` are retired; Jeeves tees `run.stream()` to the run log file on the host.

This supersedes the Docker-only Sandcastle consequences recorded in [ADR 0008](./0008-ai-sdk-assistant-ui-agent-runner.md) and the Docker preview requirement in [ADR 0009](./0009-branches-durable-worktrees-ephemeral.md) for the v1 path.

## Spike validation

Validated by [`.scratch/spike-sdk-worktree.ts`](../../.scratch/spike-sdk-worktree.ts) (`npm run spike:sdk`). **Verdict: PARTIAL GO** on native Windows (2026-07-11): worktree create/remove/isolation, SDK local runs, log streaming, uncommitted `.jeeves/plan.md` harvest, cancel, and dispose all pass. SDK native sandbox (`sandboxOptions.enabled`) is **unavailable** on this host — runs proceed without it.

Production implications from the spike:

- Branch naming: `jeeves/card-<id>` (durable branch, ephemeral worktree per run)
- After `run.cancel()`, treat `ConnectError: [canceled]` on `run.wait()` / dispose as success
- Harvest copies exchange files from the host worktree path before teardown

## Sandbox policy

Sandbox is **not required** on native Windows. When the host supports it (WSL/Linux/macOS), `sandboxOptions.enabled` may be set optionally. The runner must not fail startup when sandbox is rejected — retry or run without sandbox, as the spike does.

## Preview policy (host-process, implementation slice 9)

Human Review manual testing uses **host-process dev servers**, not Docker containers. The preview manager (not built in the execution migration) recreates a worktree at the evaluation's exact `git_sha`, runs Jeeves-owned setup/dev commands as child processes on an allocated port, probes readiness over HTTP, and kills the process tree on Stop. One lazy-retained slot; orphan cleanup on boot.

**Docker-isolated preview containers** remain a valid **deferred** option: if host-process trust becomes a concern (AI-written `postinstall` hooks, dependency scripts), `PreviewManager` can be reimplemented behind the same `ExecutionEngine.startPreview` / `stopPreview` seam without touching agent execution. Rejected for now to avoid retaining Docker Desktop, image maintenance, and container lifecycle as a permanent dev dependency after removing Docker from agent runs.

### `projects.preview_config` schema (host-process)

No `image` or `dockerfile` fields. Jeeves-owned — reviewed branches cannot alter launch policy and never inherit ambient credentials.

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
| `port` | Port the dev server listens on inside the worktree |
| `readinessPath` | HTTP path for readiness probe |
| `readinessTimeoutMs` | Max wait before preview fails |
| `envAllowlist` | Explicit env vars passed to setup/dev; never inherit Jeeves ambient secrets |

Shared port allocator with Playwright screenshot capture (slice 11). URLs use the Jeeves/Tailscale hostname, never `127.0.0.1`.

## Considered options

- **Keep Sandcastle + Docker for agent runs** — rejected: Docker Desktop, image builds, and container auth added friction; spike proved self-managed worktrees + SDK local are sufficient for a personal tool.
- **Require SDK sandbox on all hosts** — rejected: unavailable on native Windows; optional when supported.
- **Docker preview containers (v1)** — rejected for now: would reintroduce Docker as a dev dependency solely for previews; host-process + env allowlist is an acceptable trade-off for reviewing your own AI's output on your own repos. Documented as future escape hatch.

## Consequences

- `WorktreeManager` + `CursorSdkAgentRunner` replace `SandcastleAgentRunner`; prompts live under `prompts/execution/`, not `.sandcastle/prompts/`.
- `CURSOR_API_KEY` in repo-root `.env` authenticates SDK/CLI runs on the host — no Sandcastle Docker env forwarding.
- `npm run dev` and `npm test` do not require Docker Desktop.
- `npm run spike:sdk` remains the regression gate for the replacement stack.
- Preview implementation lands in slice 9 (`server/execution/preview-manager.ts`); this ADR defines the config shape only.
- [ADR 0008](./0008-ai-sdk-assistant-ui-agent-runner.md) and [ADR 0009](./0009-branches-durable-worktrees-ephemeral.md) are updated to reflect the new execution and preview paths.
