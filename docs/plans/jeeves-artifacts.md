# Artifact Strategy

> Part of the [Jeeves implementation plan](./jeeves-plan.md).

## Artifact Strategy

Artifacts are the audit trail, the review surface, the hand-off between steps, and a data
source for the UI. Those jobs pull in different directions, so "artifact" is not one thing —
there are four classes, and storage follows from the class:

| Class | Examples | Primary consumer | Wants to be… |
|---|---|---|---|
| **Human/AI prose** | Grill summary, Spec, Plan | Humans + next AI step | Editable, diffable, greppable markdown |
| **Structured state** | Draft cards + blockers, change requests, rework round, decisions, session meta (tokens/cost) | The UI and the queue | Queryable SQLite rows |
| **Composite review doc** | Task Evaluation, Feature Evaluation | Human review; linked from other evaluations | Self-contained HTML pinned to a commit SHA |
| **Media / raw** | Screenshots/GIFs, run logs, chat transcripts (`UIMessage[]`) | Occasional human, gallery | Plain files, possibly large |

### Storage: SQLite index + artifact folder

Two homes, one rule: **SQLite is the index and the source of truth for structured state; the
artifact folder is the source of truth for everything file-shaped.** No blobs in DB columns, and
nothing the UI renders on a card tile is trapped inside markdown/HTML. The user's repo stays
git-clean — no artifacts are committed to it.

**SQLite (Drizzle) — the index + orchestration state.**

- The `artifacts` table holds *metadata + a pointer*, never content (see [Data Model](./jeeves-data-model.md)).
- Structured state gets real tables (`change_requests`, `runs`, `decisions`, …), not markdown.
- The board renders tiles, progress bars, notification dots, and gates entirely from the DB —
  it never parses a file to draw a card.

**Artifact folder — all file artifacts, keyed by card.**

```
data/
└── cards/
    └── <cardId>/
        ├── manifest.json            # regenerated projection of the DB index
        └── <round>/
            ├── grill/<artifactId>.md # immutable versions; latest is derived in the index
            ├── spec/<artifactId>.md
            ├── plan/<artifactId>.md
            ├── eval/<artifactId>.html
            ├── screenshots/         # harvested from the worktree
            └── runlog/<runId>.log
```

This folder lives with the jeeves app, **outside the repo under review** — no `.gitignore`
juggling, and the VPS migration is "copy the SQLite file + `data/`". Keep the path configurable.

### Invariants

- **Immutability by round and version.** Re-running a step creates a unique destination (for
  example `plan/<artifactId>.md`), never an overwrite—even within the same round. Known worktree
  paths such as `.jeeves/plan.md` are exchange paths only. Supersession is derived — latest
  `created_at` per `(card, step, round, kind)` wins — not stored as a status flag.
- **`git_sha` on every evaluation.** The evaluation is not committed to the branch, so the SHA
  recorded in its artifact row and HTML metadata is the *only* link back to the exact diff it
  reviewed. Workspace-produced non-evaluation artifacts record HEAD when known.
- **Self-describing files.** Markdown gets YAML frontmatter; self-contained HTML gets equivalent
  `<meta>` elements or an HTML comment so metadata cannot break the document. Metadata includes
  `card_id, step, round, kind, source_skill, derived_from, git_sha, schema_version, created_at`.
- **Root-relative, file-first storage.** Only `ArtifactStore` resolves paths, with containment
  checks. It writes and validates a temporary file, atomically renames it, then inserts the DB
  row. A crash can leave a recoverable self-describing file, never a row pointing at no file.
- **Explicit provenance.** `artifact_lineage` records the real lineage graph
  (grill → spec → tasks → plan → impl → eval) as a join table, queryable in both directions.
  This is the audit trail *and* staleness detection: re-grill and the downstream spec is
  detectably stale (an upstream artifact has a newer version). It's also what lets the Feature
  Evaluation link back to each Task Evaluation.
- **`schema_version`** on artifacts so old evaluations still render after skill prompts evolve.

### Discoverability for the AI

- **Deterministic exchange paths + per-card `manifest.json`** (regenerable from the DB) listing every
  artifact with step, round, kind, path, git_sha. Agents read the manifest first instead
  of globbing; the agent worktree needs no DB access.
- **The runner injects inputs — the AI never hunts.** Each skill invocation gets the resolved
  paths/contents of its inputs explicitly (e.g. `/to-spec` receives the grill summary), resolved
  from the lineage graph by the runner. Discoverability for humans = manifest + frontmatter;
  discoverability for the pipeline = injection.

### Harvesting worktree-produced artifacts

Two production contexts, two flows:

- **Host-produced** (grill summary, spec, chat transcripts, finalized run logs): written or
  finalized by the Hono server. A live log belongs to its mutable `run`; on success or failure
  it is closed and registered as an immutable `runlog` artifact.
- **Worktree-produced** (Plan, eval HTML, screenshots, structured JSON sidecars): generated
  inside the agent's worktree via `@cursor/sdk` local. `AgentRunner` invokes an `ExecutionEngine`
  finalization callback before cleanup; it harvests declared paths from the host worktree path
  (e.g. `.jeeves/plan.md`, `.jeeves/eval.html`, `.jeeves/screenshots/`, `.jeeves/notifications.json`,
  `.jeeves/to-tasks.json`), validates them, records metadata, and removes exchange sidecars. A
  missing required artifact fails the run and preserves diagnostics. Structured sidecars are
  Zod-validated before DB mutations.

### Serving artifacts

- Hono serves the artifact folder over HTTP (`/artifacts/<cardId>/…`). The eval iframe loads from
  there, and the screenshot gallery's relative image paths resolve for free — including from
  phone/tablet over Tailscale.
- Database paths are root-relative; callers identify artifacts/cards, never arbitrary filesystem
  paths, and every resolved path is checked to remain inside the artifact root.
- The UI has a subtle **"open artifacts folder"** button per card. Remote (phone/tablet) it
  links to the HTTP directory listing; on the host it can additionally reveal the folder in
  Finder/Explorer.
- The eval iframe uses `sandbox="allow-scripts"`—no `allow-same-origin`—because it renders
  AI-generated HTML.

### QA state: parent localStorage + postMessage, one audit boolean

QA checkbox state is ephemeral UX, not the audit record, so there is **no `qa_items` table**:

- The parent board persists checkbox state in its own `localStorage`, keyed by artifact/card/round,
  and sends initial state to the iframe. The opaque-origin iframe cannot access storage.
- The iframe emits checkbox changes and aggregate status to the board:

```js
parent.postMessage({ type: 'qa-status', finished, checked, total }, '*');
```

- The board validates `event.source` and message shape, binds actions to the displayed card
  instead of trusting a card ID from HTML, persists state, and drives the QA gate live.
- **At decision-time**, the board snapshots one boolean, `qa_complete`, onto the decision row
  in SQLite (for both approve and request-changes). That answers the audit question *"was QA
  complete when this merged?"* without per-item persistence.

---
