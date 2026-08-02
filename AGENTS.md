# AGENTS.md

## Cursor Cloud specific instructions

Jeeves is a single-process, local-first workflow board (Node.js + TypeScript). A Hono API
(`server/index.ts`, port `3939`) owns all state and, in dev, a Vite/React client (port `3940`)
proxies `/api` and `/ws` to it. Standard commands live in [`README.md`](./README.md) and
[`package.json`](./package.json) — prefer those. Notes below are the non-obvious bits.

### Running / testing / building

- Dev: `npm run dev` starts the API (`:3939`) and Vite client (`:3940`) with hot reload. Open
  the board at `http://localhost:3940/`. `npm run dev:server` / `npm run dev:client` run each side alone.
- `npm run dev` first runs `scripts/ensure-ports.ts`, which **auto-kills** whatever is listening on
  `3939`/`3940` in a non-interactive shell (no prompt) — so a stale dev server is silently replaced.
- Tests: `npm test` (Vitest, 258 tests at the `server/**` module seams). Build: `npm run build`
  (`vite build` → `client/dist`, esbuild, no type-check step).
- There is **no `lint` script**. `npx tsc --noEmit` is not wired into any script and currently reports
  pre-existing type errors in `client/components/ui/alert-dialog.tsx` (a radix-ui prop mismatch);
  these do not affect `npm run build` or `npm test`. Do not treat `tsc` as the gate.
- First server boot creates a gitignored project store at `<repo>/.jeeves/` (SQLite + artifacts +
  worktrees) and runs Drizzle migrations automatically — no manual DB setup.

### AI features need extra credentials (board itself does not)

- Card management (create/edit/move/delete cards) works with **no** credentials — this is enough to
  verify the environment end-to-end via the UI.
- The AI pipeline is gated on two independent Cursor credentials that are **not** present by default:
  - `CURSOR_API_KEY` (env/`.env`) authenticates `@cursor/sdk` agent runs (Implement/AI-review steps).
    Without it the board boots but any agent run throws `CURSOR_API_KEY is not set`.
  - The **Cursor Agent CLI** (`agent` binary, installed separately + `agent login`) powers interactive
    ACP chat steps (Grill/spec). It is not installed in the base environment.
  To exercise the full grill → spec → tasks → implement pipeline you need both.
