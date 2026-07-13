# JEEVES Workflow Board — Implementation Plan

## What We're Building

A personal workflow board that runs a Matt Pocock-inspired development pipeline visually.
Cards move through a small set of **columns**; within a card, typed **steps** run in
sequence (Human, AI Chat, AI Execution), markdown artifacts accumulate per step, and the whole
thing runs from your laptop — accessible from any browser on laptop, tablet, or phone via
Tailscale.

The key insight: the board is a **pipeline monitor and async review tool**. While the AI is
autonomously building vertical slices, you're on another feature — grilling, designing,
prototyping. The board lets you check in, see progress, and step in when human judgment is
needed, without losing context on what you were doing.

---

## Architecture

```
Your laptop (always on, lid open)
  ├── Hono server (Node.js, single process)
  │     ├── Serves React board UI (responsive, all devices)
  │     ├── REST API  →  SQLite via Drizzle
  │     ├── /ws/chat  →  AcpBridge → AI SDK UIMessage stream (AI Chat steps)
  │     └── Execution queue → AgentRunner → @cursor/sdk local (composer-2.5)
  ├── Git (worktree create/remove for agent runs)
  ├── Cursor CLI + CURSOR_API_KEY (ACP chat + SDK local runs)
  └── Your repo (Cursor-indexed, warm)

Tailscale
  └── Phone / tablet / other machines reach the board privately
```

Everything runs with one command: `node server/index.ts`. No cloud dependencies, no
deployment pipeline, no Supabase, no Cloudflare — until you actually need them.

**Migration path (when ready, zero code changes):**
```
Now:    laptop + Tailscale (personal)
Later:  VPS + Tailscale or public URL (team)
Later:  extract client to Cloudflare Pages if needed
```

---

## Tech Stack

| Concern | Choice | Why |
|---|---|---|
| Server | Hono + Node.js | Lightweight, WebSocket native, runtime-agnostic |
| Database | SQLite via Drizzle | Zero setup, single file, familiar ORM |
| UI framework | React + Tailwind | Responsive, no overhead |
| Within-column reorder | `@dnd-kit` | Cards move between columns via pipeline logic, not drag — DnD is only for reordering inside a column (Backlog, draft tasks in Define, etc.) |
| Base components | shadcn/ui | Card, Badge, Button, Dialog, Sheet, Progress |
| Icons | Tabler Icons (`@tabler/icons-react`) | Project standard; shadcn `iconLibrary` is `tabler` |
| Markdown editor | MDXEditor | True WYSIWYG, outputs clean markdown, no format conversion |
| Execution engine | Self-managed worktrees + `@cursor/sdk` | Jeeves owns git worktree lifecycle; SDK local runs on host ([ADR 0010](../adr/0010-self-managed-worktrees-cursor-sdk.md)) |
| Agent | `@cursor/sdk` local (`composer-2.5`) | Your subscription; no Docker for agent runs |
| Chat state & streaming | Vercel AI SDK 5 (`ai`, `@ai-sdk/react`) | `useChat`, typed `UIMessage` parts, custom WebSocket transport |
| Chat UI | assistant-ui (`@assistant-ui/react`, `@assistant-ui/react-ai-sdk`) | Pre-built message list, composer, streaming indicators over AI SDK |
| AI chat transport | Cursor ACP bridge | Interactive sessions with full codebase context; ACP projected to `UIMessage` server-side |
| Networking | Tailscale | Private, zero config, works from phone |

> Full rationale and rejected alternatives → [ADR 0008](../adr/0008-ai-sdk-assistant-ui-agent-runner.md)

---

## AI Chat & Agent Execution

All inference runs on the Cursor subscription — no separate provider API keys.

**Chat (AI Chat steps — Grill, Spec side-chat):** Vercel AI SDK 5 provides message state and
streaming (`useChat`, typed `UIMessage` parts). assistant-ui layers pre-built chat primitives
(message list, composer, streaming indicators) on top. The real work is in `AcpBridge`: it
projects ACP JSON-RPC into `UIMessage` parts server-side and streams them over WebSocket via
a custom `ChatTransport`. ACP vocabulary never reaches the client. Permission requests (ACP
can ask the user to approve actions mid-stream) become custom message parts with a response
path back through the transport. Chat transcripts persist as serialized `UIMessage[]` artifacts.

**Execution (AI Execution steps — Plan, Implement, eval pipeline):** `ExecutionEngine` hides
an `AgentRunner` interface (`run(prompt, options): AsyncIterable<RunEvent>`). Today's
implementation is **`@cursor/sdk` local** — `WorktreeManager` creates an ephemeral worktree per
run on the durable card branch; `CursorSdkAgentRunner` runs `composer-2.5` with `cwd` set to that
worktree. No Docker for agent runs. SDK native sandbox is optional when the host supports it and
unavailable on native Windows ([ADR 0010](../adr/0010-self-managed-worktrees-cursor-sdk.md)).
This keeps the door open to swap in Vercel AI SDK's experimental `HarnessAgent` later without
touching the board, queue, or chat UI. Harness streams project into AI SDK types, so the chat
layer wouldn't change either.

**Structured skill outputs:** skills that must return parseable data (notably `/to-tasks`)
write JSON to a known worktree path; the runner harvests it and validates with a Zod schema on
the host, with retry on parse failure. We do not use `generateObject` — that would add a
second billing path and bypass Cursor's codebase context.

**Explicitly not using:** CopilotKit/AG-UI (generative UI framework), LangChain/Mastra/CrewAI
(backend orchestration — Cursor is the agent), AI Elements (redundant with assistant-ui),
Vercel Sandbox/Workflows/AI Gateway (hosted infra), HarnessAgent as primary path until
Cursor is a supported adapter and the API stabilizes.

---

## Plan documents

Large sections live in separate files so this page stays scannable:

| Document | Contents |
|---|---|
| [jeeves-workflow.md](./jeeves-workflow.md) | Columns, pipelines, steps, review & rework loop |
| [jeeves-branching.md](./jeeves-branching.md) | Git branches, worktree lifecycle, Human Review previews |
| [jeeves-data-model.md](./jeeves-data-model.md) | SQLite schema, unified card model, derivation rules |
| [jeeves-artifacts.md](./jeeves-artifacts.md) | Artifact classes, storage, harvesting, QA state |
| [jeeves-evaluation.md](./jeeves-evaluation.md) | Task vs feature evaluation, HTML sections, eval pipeline |
| [jeeves-project-structure.md](./jeeves-project-structure.md) | Repo directory map |
| [jeeves-build-order.md](./jeeves-build-order.md) | Module map, vertical slice sequence, meta-workflow |
| [`jeeves-skills.md`](./jeeves-skills.md) | Skill catalog, specs, development priorities |

---

## Resolved: execution runtime (slice 3 → ADR 0010)

**Decision:** replace Sandcastle + Docker agent execution with **self-managed git worktrees** +
**`@cursor/sdk` local**. No Docker for agent runs. Supersedes the slice-3 Docker-only gate.

**Verified on this host (`.scratch/spike-sdk-worktree.ts`, `npm run spike:sdk`):**

- `WorktreeManager` pattern: `git worktree add -B …` / `remove --force`, isolation from host checkout
- `@cursor/sdk` local with `composer-2.5`, `CURSOR_API_KEY` from repo-root `.env`
- Log streaming via `run.stream()` tee to file; uncommitted `.jeeves/plan.md` harvest on host path
- Cancel via `run.cancel()`; dispose treats `[canceled]` as success
- SDK native sandbox **unavailable** on native Windows — runs proceed without `sandboxOptions.enabled`

**Verdict:** PARTIAL GO (worktree + run + cancel pass; sandbox probe fails on Windows).

**One-time setup on a fresh machine:**

```bash
# Git + CURSOR_API_KEY in repo-root .env — no Docker Desktop required
npm run spike:sdk              # full regression gate
npm run spike:sdk -- --phase run   # plan harvest smoke only
```

See [ADR 0010](../adr/0010-self-managed-worktrees-cursor-sdk.md) for preview policy and
`preview_config` schema.

---

## What We're Explicitly NOT Building

- Multica fork
- Supabase (add later if collaboration is needed)
- Cloudflare Workers (add later if needed)
- Parallel execution (sequential queue is enough to start)
- Native mobile app (responsive web covers phone and tablet)
- Custom diff renderer (eval-assemble generates HTML with inline diffs)
- A `/prototype` step (dropped from the flow)
- CopilotKit/AG-UI, LangChain/Mastra/CrewAI, AI Elements (see
  [ADR 0008](../adr/0008-ai-sdk-assistant-ui-agent-runner.md))
- Direct provider API calls (`generateObject`/`generateText`) — all inference via Cursor
- HarnessAgent as primary execution path until Cursor adapter exists
- Vercel Sandbox/Workflows/AI Gateway hosted infra

---

## Open Questions (revisit later)

1. **Data model redesign** — *resolved:* see [Data Model](./jeeves-data-model.md); vocabulary in
   [`CONTEXT.md`](../../CONTEXT.md)
2. **Cursor Docker auth / execution runtime** — *resolved:* Sandcastle + Docker superseded by
   self-managed worktrees + `@cursor/sdk` local ([ADR 0010](../adr/0010-self-managed-worktrees-cursor-sdk.md)).
   Requires git + `CURSOR_API_KEY`; no Docker Desktop for agent runs.
3. **Parallel child card execution** — add concurrency to queue once sequential is proven
4. **Playwright screenshot capture** — *resolved for sequential v1:* reuse the Jeeves-owned
   host-process `preview_config`, readiness check, and port allocator used by manual Start Server.
   Revisit only when parallel execution requires a port pool.
5. **Colleague access** — move server to VPS, no code changes required
6. **Feature auto-advance trigger** — needs an "all children merged" event; implement as a check in
   the queue after each child card's Human Review approval
7. **Evaluation: inline vs standalone HTML** — *resolved:* the prototype inlines it; production
   generates a self-contained HTML file, harvested into the artifact folder and rendered in a
   `sandbox="allow-scripts"` iframe; the parent owns browser-local QA state and validates
   `postMessage` (see [Artifact Strategy](./jeeves-artifacts.md)).
8. **Worktree lifecycle + manual testing** — *resolved:* branches are durable, worktrees are
   fresh per run and recreated from explicit refs/SHAs; Implement steps share a task branch and
   explicit artifacts, not a physical worktree. Human Review previews recreate the exact evaluated
   SHA and run with Jeeves-owned host-process configuration (see
   [Worktree lifecycle](./jeeves-branching.md#worktree-lifecycle-branches-are-durable-worktrees-are-ephemeral),
   [Testing a card in Human Review](./jeeves-branching.md#testing-a-card-in-human-review), and
   [ADR 0009](../adr/0009-branches-durable-worktrees-ephemeral.md)).
