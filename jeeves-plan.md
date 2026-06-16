# JEEVES Workflow Board — Implementation Plan

## What We're Building

A personal workflow board that runs a Matt Pocock-inspired development pipeline visually.
Cards move through typed stages (Human, AI Chat, AI Execution), markdown artifacts accumulate
per stage, and the whole thing runs from your laptop — accessible from any browser on laptop,
tablet, or phone via Tailscale.

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
  │     ├── /ws/chat  →  Cursor ACP bridge (AI Chat stages)
  │     └── Execution queue → Sandcastle + cursor("composer-2")
  ├── Docker Desktop (Sandcastle sandbox requirement)
  ├── Cursor CLI (authenticated, your subscription)
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
| Kanban board | ReUI Kanban | shadcn-compatible, copy-and-own, `@dnd-kit` under the hood |
| Base components | shadcn/ui | Card, Badge, Button, Dialog, Sheet, Progress |
| Markdown editor | MDXEditor | True WYSIWYG, outputs clean markdown, no format conversion |
| Execution engine | Sandcastle | Handles worktrees, branches, merging — already solved |
| Agent | `cursor("composer-2")` | Your subscription, Cursor's codebase intelligence |
| AI Chat | Cursor ACP bridge | Interactive sessions with full codebase context |
| Networking | Tailscale | Private, zero config, works from phone |

---

## The Workflow

### Parent card: "A new feature"

```
Stage 1:  Discuss with stakeholders    [human]
Stage 2:  /prototype                   [ai-chat]
Stage 3:  /grill-with-docs             [ai-chat]
Stage 4:  /to-prd                      [ai-execution]
Stage 5:  /to-issues                   [ai-execution]  ← generates child cards
```

`/to-issues` fans out into child cards, one per vertical slice. The parent card then
waits until all children are merged.

### Child cards: vertical slices (run sequentially per card, independently of siblings)

```
Stage 6:  /plan-implementation         [ai-execution]
Stage 7:  /implement-issue             [ai-execution]  ← triggers eval plan pipeline
Stage 8:  /review                      [ai-execution]  ← thermo-nuclear-review
Stage 9:  Human review                 [human]         ← you step in
```

### Parent card resumes (after all children merged)

```
Stage 10: /improve-architecture        [ai-execution]
Stage 11: /deploy                      [ai-execution]
```

---

## Branching Strategy

```
main
  └── feat/my-feature                  ← feature branch (parent card)
        ├── feat/my-feature/card-1     ← child worktree, merges → feat/my-feature
        ├── feat/my-feature/card-2     ← child worktree, merges → feat/my-feature
        └── feat/my-feature/card-3     ← child worktree, merges → feat/my-feature

All children merged ↓

feat/my-feature
  → /improve-architecture
  → /deploy
  → PR opened: feat/my-feature → main
```

Sandcastle's branch strategy handles this. Child cards set:
```typescript
branchStrategy: {
  type: "branch",
  branch: `feat/${featureName}/${cardId}`,
  baseBranch: `feat/${featureName}`   // merges back to feature branch, not main
}
```

---

## Data Model

```typescript
type Card = {
  id: string
  title: string
  description: string
  workflow_id: string
  parent_card_id: string | null      // null for parent cards
  current_stage_id: string
  branch: string | null              // set when execution starts
  pr_url: string | null              // set after /implement-issue
  depends_on: string[]               // other card IDs (from /to-issues output)
  created_at: string
  updated_at: string
}

type Artifact = {
  id: string
  card_id: string
  stage_id: string
  content: string                    // markdown for most stages
  eval_plan_path: string | null      // path to generated HTML file for stage 8
  created_at: string
  updated_at: string
}

type Workflow = {
  id: string
  name: string
  stages: Stage[]
}

type Stage = {
  id: string
  name: string
  type: 'human' | 'ai-chat' | 'ai-execution'
  skill_prompt: string | null        // path to .sandcastle/prompts/ file
  order: number
  auto_advance: boolean              // false for human stages
  is_child_stage: boolean            // stages 6-9 belong to child cards
}

type ExecutionRun = {
  id: string
  card_id: string
  stage_id: string
  skill_id: string | null            // for sub-skills within a stage
  status: 'queued' | 'running' | 'done' | 'failed' | 'waiting-human'
  log: string
  tokens_used: number | null
  cost_usd: number | null
  started_at: string | null
  finished_at: string | null
}
```

---

## The Evaluation Plan

The evaluation plan is a self-contained HTML file generated by a pipeline of skills
after `/implement-issue`. It's the single artifact that both the AI review (stage 8)
and the human review (stage 9) work from.

### Why HTML, not markdown

The evaluation plan needs interactive checkboxes with persistence, syntax-highlighted
diffs, a sticky TOC, file links that open in Cursor, and an embedded screenshot gallery.
A self-contained HTML file with inline CSS and `localStorage` for checkbox state handles
all of this with no dependencies. It opens in any browser, works offline, and is committed
to the branch alongside the code.

### Sections

**⚠️ Attention flags** (sticky, always visible)
Consolidated flags raised by any skill in the pipeline. Things the developer must look
at before approving. Categorised as: Deviation from plan / Test gap / Review finding /
Unresolved uncertainty. This section is assembled last but displayed first.

**Summary**
What was built, why, and how. Written for someone context-switching back after working
on a different feature. Should answer: "What problem does this solve, and does it solve
it the right way?"

**Screenshot / GIF gallery**
Captured by Playwright after dev server spin-up. Annotated with what each screenshot
shows. Falls back to a text description of what to visually verify if capture fails.

**Narrative diff**
Git diff reordered by architectural layer, not file path. Reads: schema → migrations →
API → business logic → UI → tests. Each group has a one-paragraph explanation of what
changed and why. Every file reference is a `cursor://file/path:line` link — one click
opens it in Cursor at the right line.

**Tests**
Full test run output. Pass/fail per suite. Coverage summary. Any new tests added during
implementation highlighted. Flags if coverage dropped on touched modules.

**Interactive QA plan**
Actionable checklist items specific to what was built. Each item is a checkbox with
`localStorage` persistence — check them off on your phone as you test. Items are specific
("Log in with an invalid password — confirm error message appears") not vague ("Test auth").

**AI review** (thermo-nuclear-review)
Full output of the review skill. Categorised findings: Critical / Major / Minor /
Suggestion. Each finding links to the relevant file via `cursor://` URI. The developer
chooses which points to act on — this is a surface-everything pass, not a blocker list.

**Session meta**
Duration, token usage, estimated cost, number of retries/issue resolutions, Cursor
model used, timestamp. Useful for understanding which types of tasks are expensive or
slow over time.

### Evaluation plan as a skill pipeline

Each section is its own skill, run sequentially after `/implement-issue`:

```
/implement-issue  (code is written, tests pass)
      ↓
/eval-summary          → Summary section (markdown fragment)
      ↓
/eval-screenshots      → Playwright captures, Gallery section
      ↓
/eval-diff-narrative   → Reads git diff, orders logically, Diff section
      ↓
/eval-tests            → Runs test suite, Tests section
      ↓
/eval-qa-plan          → Writes QA checklist section
      ↓
/thermo-nuclear-review → AI Review section (existing Cursor skill)
      ↓
/eval-assemble         → Combines all fragments + collects attention flags
                         → writes self-contained HTML file
                         → commits to branch
```

**Why this decomposition:**
Each skill has a single focused job. You can re-run any section independently — if the
diff narrative is unclear, re-run just `/eval-diff-narrative` and `/eval-assemble`. Each
skill can emit its own attention flags, which `/eval-assemble` consolidates at the top.

### Evaluation plan visibility on the board

Stage 8 shows a mini-pipeline in the RunLog, not just a single "running" state:

```
Stage 8: /review
  ✓ /eval-summary           (12s)
  ✓ /eval-screenshots       (34s)
  ✓ /eval-diff-narrative    (28s)
  ✓ /eval-tests             (15s)
  ✓ /eval-qa-plan           (19s)
  ⟳ /thermo-nuclear-review  ← running
  ○ /eval-assemble
```

When complete, a "View evaluation plan" button opens the HTML file in a new tab.

---

## Project Structure

```
nxtfit-board/
├── package.json
├── tsconfig.json
├── drizzle.config.ts
│
├── server/
│   ├── index.ts                    # Hono app entry, serves client + API + WS
│   ├── db/
│   │   ├── schema.ts               # Drizzle schema
│   │   └── index.ts                # db connection (better-sqlite3)
│   ├── routes/
│   │   ├── cards.ts                # CRUD, stage transitions, fan-out
│   │   ├── artifacts.ts            # read/write per-stage markdown
│   │   ├── workflows.ts            # workflow + stage definitions
│   │   └── runs.ts                 # execution run log
│   ├── ws/
│   │   └── chat.ts                 # ACP bridge: spawn agent acp, pipe JSON-RPC
│   └── execution/
│       ├── queue.ts                # sequential in-memory queue + dependency check
│       └── runner.ts               # Sandcastle invocation, eval pipeline, log streaming
│
├── client/
│   ├── index.html
│   ├── main.tsx
│   ├── components/
│   │   ├── Board.tsx               # ReUI Kanban, columns = stages, cards grouped
│   │   ├── Card.tsx                # title, stage badge, run status, attention flag dot
│   │   ├── CardDetail.tsx          # slide-over panel, shows active stage UI
│   │   ├── StageHuman.tsx          # MDXEditor + "Mark done" button
│   │   ├── StageChat.tsx           # streaming chat for ai-chat stages
│   │   ├── StageExecution.tsx      # live RunLog + mini eval pipeline progress
│   │   ├── ArtifactViewer.tsx      # read-only markdown render of past stage artifacts
│   │   └── EvalPlanLink.tsx        # "View evaluation plan" → opens HTML in new tab
│   └── hooks/
│       ├── useBoard.ts             # cards + stage state, SSE for live updates
│       └── useChat.ts              # ACP WebSocket session management
│
└── .sandcastle/
    ├── prompts/
    │   ├── to-prd.md
    │   ├── to-issues.md             # outputs structured JSON with depends_on
    │   ├── plan-implementation.md
    │   ├── implement-issue.md
    │   ├── eval-summary.md
    │   ├── eval-screenshots.md
    │   ├── eval-diff-narrative.md
    │   ├── eval-tests.md
    │   ├── eval-qa-plan.md
    │   ├── eval-assemble.md         # produces final HTML, collects attention flags
    │   ├── improve-architecture.md
    │   └── deploy.md
    └── main.ts                      # Sandcastle entry point (used by runner.ts)
```

---

## UI Design Direction

Tool-like, not consumer. The board should feel like a terminal that grew a GUI —
something you'd see at a well-equipped engineering workstation, not a SaaS landing page.

**Palette:** Near-black background (`#0e0e0f`), off-white text (`#e8e8e6`), with three
accent colours encoding stage type:
- Blue (`#3b82f6`) — Human stages
- Amber (`#f59e0b`) — AI Chat stages
- Emerald (`#10b981`) — AI Execution stages

**Cards:** Monospace title font (JetBrains Mono), coloured left border per stage type,
a small red dot for unread attention flags. Compact — show as much of the board as
possible without scrolling.

**Card detail:** Full-height slide-over panel from the right. Top section shows the
active stage UI (chat, editor, or run log). Below it, a collapsible history of all
previous stage artifacts in order — so you can read the full story of how the card
evolved from problem statement to implementation.

**Mobile:** On small screens, the board collapses to a vertical list of stages with
horizontal card scroll within each. Card detail opens full-screen. Chat interface is
the primary mobile interaction — large input, readable bubbles, easy "End session"
button.

---

## Build Order

### Phase 1 — Foundation (Day 1)

Data layer and server. Nothing AI yet.

1. `pnpm init`, install Hono, `@hono/node-server`, Drizzle, `better-sqlite3`, Vite, React
2. Write `server/db/schema.ts`
3. `drizzle-kit generate` + `drizzle-kit migrate`
4. Seed the "A new feature" workflow with all 11 stages
5. REST routes: cards CRUD, stage transition (`PATCH /api/cards/:id/advance`), artifacts read/write
6. Verify with curl: create card, advance through stages, read artifact

### Phase 2 — Board UI (Day 1–2)

Visual board, no AI. This is the thing you'll use from phone and tablet.

1. Vite dev server proxying API calls to Hono
2. `Board.tsx` — ReUI Kanban, columns = stages, cards show title + stage badge
3. `CardDetail.tsx` — slide-over, shows MDXEditor for human stages (read-only view first)
4. `StageHuman.tsx` — MDXEditor + "Mark done" → calls advance endpoint
5. `ArtifactViewer.tsx` — renders previous stage markdown below active stage
6. Responsive layout: horizontal board on desktop, vertical stage list on mobile
7. Tailscale test: access from phone, confirm board loads and cards are tappable

### Phase 3 — AI Chat Stage (Day 2–3)

Grill sessions with full codebase context from your phone.

1. Confirm `agent acp` starts a JSON-RPC server over stdio
2. `server/ws/chat.ts`:
   - On WebSocket connect: spawn `agent acp`, pass skill prompt as system context
   - Pipe JSON-RPC messages between client WebSocket and ACP stdio
   - On disconnect: kill ACP process, save conversation summary as artifact
3. `StageChat.tsx`:
   - Message list, streaming assistant responses
   - Input field, send on Enter (or tap Send on mobile)
   - "End session & save" button — sends final summary prompt, saves artifact, advances card
4. Test a /grill-with-docs session on laptop, then from phone via Tailscale

**End-of-session summary prompt:**
```
Summarise this entire conversation as a structured markdown document.
Include: the problem statement as clarified, key assumptions surfaced,
constraints identified, open questions remaining, and a readiness assessment.
This will be used as input to /to-prd.
```

### Phase 4 — AI Execution Stage (Day 3–4)

Autonomous pipeline. Cards move through plan → implement → review on their own.

1. `npx @ai-hero/sandcastle init` — choose cursor provider
2. Write initial prompt files: `plan-implementation.md`, `implement-issue.md`
3. `server/execution/runner.ts` — Sandcastle invocation with cursor provider,
   branch strategy pointing to feature branch, log streaming via WebSocket
4. `server/execution/queue.ts` — sequential queue, `depends_on` check before dequeue
5. Wire stage transitions: card entering `ai-execution` stage → enqueue
6. `StageExecution.tsx` — live streaming RunLog, visible in card detail
7. **Test Cursor auth in Docker** — first real unknown:
   - Run on a trivial prompt: "create a file called hello.txt containing 'hello'"
   - If Docker auth fails: swap to `noSandbox()` — one line change, fine for personal use

### Phase 5 — Evaluation Plan Pipeline (Day 4–5)

The artifact that makes async review actually work.

1. Write all eval skill prompts (`eval-summary.md` through `eval-assemble.md`)
2. Extend `runner.ts` to run eval skills sequentially after `/implement-issue`
3. Update `StageExecution.tsx` to show mini-pipeline progress per skill
4. `eval-assemble` writes HTML file to branch, path saved in `Artifact.eval_plan_path`
5. `EvalPlanLink.tsx` — "View evaluation plan" button appears when HTML is ready
6. Test full pipeline on a real small task in nxtfit repo

### Phase 6 — `/to-issues` Fan-out (Day 5)

The step that makes the board multi-card.

1. Write `/to-issues` prompt to output structured JSON:
```
<issues>
[
  { "title": "Login API", "description": "...", "depends_on": [] },
  { "title": "Login UI", "description": "...", "depends_on": ["Login API"] }
]
</issues>
```
2. After stage completes: parse output, create child cards in SQLite
3. Child cards inherit parent workflow but start at stage 6
4. Board: child cards grouped under parent (collapsible), parent shows "3/5 complete" progress
5. Queue: respects `depends_on` — card waits until dependency's human review is done and
   branch is merged into feature branch

### Phase 7 — Polish (Day 6+)

- Browser Notification API push when a card enters Human review stage
- "Restart stage" button — re-queues card at current stage
- Attention flag dot on card tile — red if unread flags in eval plan
- Session meta display — tokens/cost/duration visible in run log and eval plan
- `/improve-architecture` trigger — fires automatically when all child cards reach "done"
- Stage history sidebar — all artifacts for a card in chronological order

---

## Key Prompt Engineering Investment

The quality of the entire system depends on these prompts. Prioritise in this order:

1. `/eval-diff-narrative` — hardest to get right, highest value for review speed
2. `/eval-qa-plan` — must be specific and actionable, not generic
3. `/thermo-nuclear-review` — already exists in Cursor, wire it in
4. `/to-issues` — quality here determines whether child cards are truly independent
5. `/eval-assemble` — attention flag consolidation logic is subtle, test carefully

Each prompt should be developed and tested independently before being wired into the
pipeline. Run it manually against a real recent PR or diff from nxtfit to validate output
quality before trusting it to run automatically.

---

## First Unknown to Resolve

**Cursor auth in Docker (Day 3–4):**

```bash
npx @ai-hero/sandcastle init   # choose cursor, docker
# edit .sandcastle/main.ts to use cursor("composer-2")
npx tsx .sandcastle/main.ts    # run on trivial task
```

If it works: done. If Docker auth fails:

```typescript
// runner.ts — one line change
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox"
sandbox: noSandbox()   // runs directly on host, no container
```

No architectural consequences either way.

---

## What We're Explicitly NOT Building

- Multica fork
- Supabase (add later if collaboration is needed)
- Cloudflare Workers (add later if needed)
- Parallel execution (sequential queue is enough to start)
- Native mobile app (responsive web covers phone and tablet)
- Custom diff renderer (eval-assemble generates HTML with inline diffs)

---

## Open Questions (revisit later)

1. **Cursor Docker auth** — resolved on Day 3–4, fallback is clear
2. **Parallel child card execution** — add concurrency to queue once sequential is proven
3. **Playwright screenshot capture** — needs dev server running in worktree; may need
   a port-allocation strategy if multiple cards run in parallel later
4. **Colleague access** — move server to VPS, no code changes required
5. **`/improve-architecture` trigger** — needs "all children merged" event; implement
   as a check in the queue after each child card completes human review
