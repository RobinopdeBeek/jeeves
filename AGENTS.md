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

### AI features need a valid `CURSOR_API_KEY`

- Card management (create/edit/move/delete cards) works with **no** credentials — enough to verify the
  board + SQLite store end-to-end via the UI.
- `@cursor/sdk` agent runs (Implement / AI-review) and the Cursor Agent CLI (Grill/spec ACP chat) both
  authenticate with `CURSOR_API_KEY`. The CLI also accepts `--api-key` / the same env var — a separate
  interactive `agent login` is **not** required when the key is set.
- The Agent CLI (`agent` / `cursor-agent`) lives at `~/.local/bin` after
  `curl -fsSL https://cursor.com/install | bash`. Ensure that dir is on `PATH` before `npm run dev`
  so ACP chat can spawn `agent acp`.
- `scripts/dev-guard.ts` only warns when the key is **missing**; an **invalid** key still boots the
  board. Validate with something like
  `agent --api-key "$CURSOR_API_KEY" -p --mode ask "Reply with exactly: OK"`
  (or a tiny `@cursor/sdk` `Agent.create` call) before assuming the AI pipeline will work.
- First boot of a target repo that is missing a `.jeeves/` gitignore entry will **append**
  `.jeeves/` to that repo's `.gitignore` (see `server/project-store.ts`). That is expected runtime
  behavior, not something to commit unless you intentionally want it tracked.
