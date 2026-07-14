# jeeves

A personal workflow board that runs a Matt Pocock-inspired development pipeline visually.

Docs: [`docs/plans/jeeves-plan.md`](./docs/plans/jeeves-plan.md) (plan hub) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) ·
[`CONTEXT.md`](./CONTEXT.md) (domain glossary) · [`docs/adr/`](./docs/adr/)

## Prerequisites

- **Git** — worktree create/remove for agent runs and previews
- **`CURSOR_API_KEY`** — authenticates `@cursor/sdk` local agent runs and Cursor CLI (ACP chat). Copy [`.env.example`](./.env.example) to `.env` and set the key.
- **No Docker Desktop** — agent runs and dev bootstrap do not require Docker

Regression gate for the execution stack:

```bash
npm run spike:sdk              # all phases
npm run spike:sdk -- --phase run   # plan harvest + log streaming only
```

## Running

```bash
npm install
npm run build     # build the client (client/dist)
npm start         # serve board + API on http://0.0.0.0:3939
```

The server binds `0.0.0.0`, so the board is reachable from phone/tablet over Tailscale.

Point Jeeves at a **target repository** (your application code). On first use Jeeves creates a
gitignored **project store** at `<repo>/.jeeves/` — SQLite, artifacts, and worktrees for that
project ([ADR 0011](./docs/adr/0011-project-store-in-target-repo-gitignored.md)). The Jeeves app
repo itself holds only the board server and UI.

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `JEEVES_PORT` | `3939` | API/server HTTP port |
| `JEEVES_CLIENT_PORT` | `3940` | Vite dev client port |
| `JEEVES_REPO_PATH` | Jeeves repo root | Target repository of the default project; store lives at `<repo>/.jeeves/` |
| `JEEVES_DB_PATH` | `<repo>/.jeeves/jeeves.db` | Override SQLite path for the active project store |
| `JEEVES_WORKTREE_ROOT` | `<repo>/.jeeves/worktrees` | Override ephemeral worktree directory |

For dogfooding with the Pantry Checker fixture, set `JEEVES_REPO_PATH` to the sibling repo path
(see [`.env.example`](./.env.example)).

## Development

```bash
npm run dev          # API (:3939) + Vite (:3940) with hot reload
npm run dev:server   # Hono API only (tsx watch)
npm run dev:client   # Vite only, proxies /api to :3939

Vite binds `0.0.0.0`, so with `npm run dev` you can open the board from phone/tablet over Tailscale at `<tailscale-ip>:3940`.
npm test             # Vitest — tests live at the module seams (server/**)
npm run db:generate  # generate a Drizzle migration after editing server/db/schema.ts
```

Migrations run automatically on server boot.
