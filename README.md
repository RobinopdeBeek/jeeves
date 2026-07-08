# jeeves

A personal workflow board that runs a Matt Pocock-inspired development pipeline visually.

Docs: [`jeeves-plan.md`](./jeeves-plan.md) (the plan) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) ·
[`CONTEXT.md`](./CONTEXT.md) (domain glossary) · [`docs/adr/`](./docs/adr/)

## Running

```bash
npm install
npm run build     # build the client (client/dist)
npm start         # serve board + API on http://0.0.0.0:3000
```

The server binds `0.0.0.0`, so the board is reachable from phone/tablet over Tailscale.

Environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `JEEVES_PORT` | `3000` | HTTP port |
| `JEEVES_DB_PATH` | `./data/jeeves.db` | SQLite file |
| `JEEVES_REPO_PATH` | repo root | Target repository of the default project |

## Development

```bash
npm run dev          # API (:3000) + Vite (:5173) with hot reload
npm run dev:server   # Hono API only (tsx watch)
npm run dev:client   # Vite only, proxies /api to :3000

Vite binds `0.0.0.0`, so with `npm run dev` you can open the board from phone/tablet over Tailscale at `<tailscale-ip>:5173`.
npm test             # Vitest — tests live at the module seams (server/**)
npm run db:generate  # generate a Drizzle migration after editing server/db/schema.ts
```

Migrations run automatically on server boot.
