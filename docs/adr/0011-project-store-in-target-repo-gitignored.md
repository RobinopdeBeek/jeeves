# Project store colocated in the target repo (`.jeeves/`, gitignored)

Each target repository owns a **project store** at `<repo>/.jeeves/`. Jeeves creates it on first use when pointed at a project. The store holds that project's SQLite database and artifact tree. The folder is **gitignored** — workflow state stays on disk beside the code it describes, but never enters git history.

This supersedes [ADR 0007](./0007-artifacts-outside-the-repo-evals-pinned-by-sha.md). ADR 0007 placed all storage with the Jeeves application repo; this ADR moves per-project storage into the target repo while keeping the same git-clean guarantee.

## Layout

```
<target-repo>/
├── src/ …                        # application code (committed)
├── .gitignore                    # must include `.jeeves/` (Jeeves adds on init if missing)
└── .jeeves/                      # gitignored project store (Jeeves-owned)
    ├── jeeves.db                 # SQLite: cards, steps, runs, artifacts index, …
    ├── data/
    │   └── cards/<cardId>/
    │       ├── manifest.json
    │       └── <round>/          # grill/, spec/, plan/, eval/, screenshots/, runlog/, …
    └── worktrees/                # ephemeral card worktrees (not committed)
        └── <cardId>/
```

The Jeeves **application** repository holds only the board server, client, prompts, and skills — no per-project board state.

## Three `.jeeves` roles (do not conflate)

| Role | Location | Lifetime | In git? |
|---|---|---|---|
| **Project store** | `<repo>/.jeeves/` on the host | Durable | No (gitignored) |
| **Worktrees** | `<repo>/.jeeves/worktrees/<cardId>/` | Ephemeral per run | No |
| **Exchange files** | `<worktree>/.jeeves/plan.md`, `.jeeves/to-tasks.json`, … | One run; harvested then removed | No |

- The **store** is read and written only by Jeeves on the host, resolved from `projects.repo_path`. Agent prompts must not treat the store as a writable workspace.
- **Exchange files** live in the ephemeral card worktree during a run. `ArtifactStore.harvest` copies validated outputs into the store, then removes them from the worktree.
- **Worktrees** stay under the project store so a project is self-contained for backup and multi-project isolation. They remain outside git via the parent `.jeeves/` ignore rule.

## Initialization

When Jeeves opens or registers a project at `repo_path`:

1. Create `<repo>/.jeeves/`, `data/`, and `worktrees/` if absent.
2. Open or create `<repo>/.jeeves/jeeves.db` (migrations run against this file).
3. Ensure `<repo>/.gitignore` contains a `.jeeves/` entry (append if missing; do not overwrite unrelated rules).

`preview_config` and `default_branch` remain project metadata in SQLite — they are not executable config committed from the target repo's branches ([ADR 0010](./0010-self-managed-worktrees-cursor-sdk.md)).

## Evaluations and `git_sha`

Evaluations are still **not committed** to the target repo. Every evaluation artifact records the reviewed commit's `git_sha` on its artifact row and in self-describing HTML metadata; that SHA remains the link back to the exact diff. Colocation on disk does not change this rule.

Manual preview testing still checks out the evaluation's exact `git_sha`, never the mutable branch tip ([ADR 0009](./0009-branches-durable-worktrees-ephemeral.md)).

## Considered options

- **Keep all storage in the Jeeves app repo** (ADR 0007) — rejected for multi-project use: one global `data/` mixes projects, and board state does not travel with the target repo on disk.
- **Colocate and commit `.jeeves/` for colleague sharing** — rejected for v1: SQLite cannot be merged; eval HTML, screenshots, and run logs bloat history; run logs may contain sensitive context. Selective export of human-readable artifacts may be revisited later; it is out of scope here.
- **Colocate on disk, gitignored** — **chosen**: project portability and isolation without git pollution or merge conflicts.

## Consequences

- `projects.repo_path` implies store paths: `jeeves.db` at `<repo>/.jeeves/jeeves.db`, artifact root at `<repo>/.jeeves/data/`, worktree root at `<repo>/.jeeves/worktrees/`. Env overrides (`JEEVES_DB_PATH`, etc.) apply to the active project store, not a global Jeeves-app `data/` directory.
- One Jeeves server process may serve multiple projects; each project's store is independent. Switching the active project switches DB and artifact root.
- Backup of a project: copy the target repo working tree including `.jeeves/` (or rely on host backup of that path). VPS migration: clone or copy the target repo + `.jeeves/`, point Jeeves at `repo_path`, run the same server command.
- [ADR 0003](./0003-sqlite-is-the-index-files-are-the-truth.md) unchanged in substance: SQLite indexes file-shaped artifacts under the configured artifact root; `ArtifactStore` still rejects path resolution outside that root (now `<repo>/.jeeves/data/`).
- [ADR 0005](./0005-immutability-by-round.md) unchanged: exchange files such as `.jeeves/plan.md` remain harvest-only; canonical artifacts live under `data/cards/<cardId>/<round>/`.
- Target repos used as Jeeves fixtures (e.g. pantry-checker) gain a gitignored `.jeeves/` on first run; resetting the fixture is `git checkout main` plus optional deletion of `.jeeves/` and `jeeves/card-*` branches.
- Implementation updates `server/index.ts`, `ArtifactStore`, `WorktreeManager`, and docs that referenced a global `jeeves/data/` store ([`ARCHITECTURE.md`](../../ARCHITECTURE.md), [`jeeves-artifacts.md`](../plans/jeeves-artifacts.md), [`CONTEXT.md`](../../CONTEXT.md)).
