# Coding standards for AI-heavy TypeScript projects

**Verdict:** Matt Pocock does **not** publish a reusable Total TypeScript / `tt-ai` `CODING_STANDARDS.md` style bible. He *does* treat `CODING_STANDARDS.md` (or `CONTRIBUTING.md`) as the Standards axis input for `/code-review`, ships a real project-specific one in `sandcastle`, and teaches adjacent patterns: short `AGENTS.md`/`CLAUDE.md` standing briefs, progressive disclosure of style guides behind skills/pointers, `CONTEXT.md` for domain language, and `writing-for-agents` for how to write agent docs. For Jeeves-like repos, the best-fit pattern is: keep `AGENTS.md` tiny and always-on; put reviewable, falsifiable coding rules in an on-demand `CODING_STANDARDS.md` (what `/code-review` already looks for); leave ubiquitous language in `CONTEXT.md`, structure/ADRs in `ARCHITECTURE.md`, and deep-module craft in skills — and push formatting into tooling, not prose.

**Date of research:** 2026-08-09

---

## Findings

### 1. Matt does not ship a general CODING_STANDARDS.md for Total TypeScript / skills

**Claim:** Across Matt’s primary public repos checked for this research, there is no root `CODING_STANDARDS.md` in `mattpocock/skills` or `mattpocock/dictionary-of-ai-coding`, and no Total TypeScript book repo standards file. The skills repo uses `AGENTS.md` / `CLAUDE.md` + `CONTEXT.md`, not a coding-standards markdown.

**Source:** HTTP checks of raw GitHub files — `https://raw.githubusercontent.com/mattpocock/skills/main/CODING_STANDARDS.md` → 404; same for `dictionary-of-ai-coding` and `total-typescript/total-typescript-book`. Repo roots: [mattpocock/skills](https://github.com/mattpocock/skills), [mattpocock/dictionary-of-ai-coding](https://github.com/mattpocock/dictionary-of-ai-coding).

**Evidence:** `skills` root listing includes `AGENTS.md`, `CLAUDE.md`, `CONTEXT.md`, `docs/`, `skills/` — not `CODING_STANDARDS.md` or `CONTRIBUTING.md`. `AGENTS.md` / `CLAUDE.md` content is harness/repo-organization rules for the skills library itself (bucket layout, plugin manifests, docs sync), not a TypeScript style guide.

---

### 2. Matt *does* expect CODING_STANDARDS.md as the Standards input for code-review

**Claim:** The `code-review` skill (and its public docs) treat the repo’s documented standards — explicitly naming `CODING_STANDARDS.md` or `CONTRIBUTING.md` — as the primary Standards source, with a Fowler smell baseline only as fallback. Repo docs always override the baseline; anything a linter already enforces is skipped.

**Source:** [skills/engineering/code-review/SKILL.md](https://github.com/mattpocock/skills/blob/main/skills/engineering/code-review/SKILL.md); [docs/engineering/code-review.md](https://github.com/mattpocock/skills/blob/main/docs/engineering/code-review.md). Jeeves vendored copy: `.agents/skills/code-review/SKILL.md`.

**Evidence (quote):** “Identify the standards sources — Anything in the repo that documents how code should be written, such as `CODING_STANDARDS.md` or `CONTRIBUTING.md`.” Docs: “The Standards axis needs nothing. It reads whatever the repo documents (`CODING_STANDARDS.md`, `CONTRIBUTING.md`, and the like) and falls back on a built-in baseline when the repo documents nothing… **the repo always overrides**… Anything your linter already enforces is skipped by both axes.”

---

### 3. Matt’s sandcastle: project CODING_STANDARDS.md + empty reviewer templates

**Claim:** Adjacent to a literal “Matt coding standards product,” the strongest artifact is `mattpocock/sandcastle`’s checked-in `.sandcastle/CODING_STANDARDS.md` (Effect, testing, deep modules, provider seams) plus empty templates under `src/templates/*/CODING_STANDARDS.md` that the sequential-reviewer agent loads at review time — “enforced during review without costing tokens during implementation.”

**Source:** [`.sandcastle/CODING_STANDARDS.md`](https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/CODING_STANDARDS.md); [template](https://github.com/mattpocock/sandcastle/blob/main/src/templates/sequential-reviewer/CODING_STANDARDS.md); sandcastle root [AGENTS.md](https://github.com/mattpocock/sandcastle/blob/main/AGENTS.md) / [CLAUDE.md](https://github.com/mattpocock/sandcastle/blob/main/CLAUDE.md).

**Evidence:** Template header comment: “The reviewer agent loads it during code review via `@.sandcastle/CODING_STANDARDS.md` so these standards are enforced during review without costing tokens during implementation.” Real `.sandcastle/CODING_STANDARDS.md` includes Effect DI rules, tagged errors (with BAD/GOOD examples), public-API JSDoc, path separator gotchas, optional-param caution, testing “through public interfaces,” TDD vertical slices, and an **Interface Design → Deep Modules** section (“Prefer deep modules: small interface, deep implementation…”). Root `AGENTS.md`/`CLAUDE.md` stay short: typecheck command, pointer to `CONTEXT.md`, changesets, and `## Agent skills` pointers to `docs/agents/*`.

---

### 4. Matt’s adjacent guidance: AGENTS.md as brief + progressive disclosure + writing-for-agents

**Claim:** Matt’s published AI-coding dictionary and `writing-for-agents` skill argue that always-loaded agent briefs must stay short; style guides belong behind skills/context pointers, not inlined into `AGENTS.md`.

**Source:** [dictionary/AGENTS.md.md](https://github.com/mattpocock/dictionary-of-ai-coding/blob/main/dictionary/AGENTS.md.md); [dictionary/Progressive disclosure.md](https://github.com/mattpocock/dictionary-of-ai-coding/blob/main/dictionary/Progressive%20disclosure.md); [skills/productivity/writing-for-agents/SKILL.md](https://github.com/mattpocock/skills/blob/main/skills/productivity/writing-for-agents/SKILL.md); [skills CONTEXT.md](https://github.com/mattpocock/skills/blob/main/CONTEXT.md).

**Evidence:** AGENTS.md dictionary: “Suitable content is whatever the agent can't derive from the code… Short and declarative — it's a brief, not documentation… _Avoid:_ using AGENTS.md for content that should be progressively disclosed… A style guide can go behind a skill or a context pointer instead.” Progressive disclosure: stuffing the full style guide into AGENTS.md “makes the agent worse at all of them.” `writing-for-agents`: context pointers, progressive disclosure ladder, prefer positive instructions over negation, prune no-ops and caches of what the environment already states (`package.json`, layout). Domain vocab lives in `CONTEXT.md` (skills repo mirrors Jeeves’ pattern).

**Also:** Matt’s essay [A Complete Guide To AGENTS.md](https://www.aihero.dev/a-complete-guide-to-agents-md) restates the same split: root `AGENTS.md` stays minimal; domain-specific rules (TypeScript, testing) live in nested docs or skills the agent loads when needed. He publishes no separate Total TypeScript coding-standards product — the pattern *is* the product.

**Related but not Matt’s own standards:** He forks [ciembor/agent-rules-books](https://github.com/ciembor/agent-rules-books) as [mattpocock/agent-rules-books](https://github.com/mattpocock/agent-rules-books) — book-distilled mini/nano/full rule packs (Ousterhout, Fowler, Clean Code, …) meant as on-demand skills, not a project house style guide. Useful inspiration for review-time checklists; not a substitute for repo-specific `CODING_STANDARDS.md`.

---

### 5. Official AGENTS.md convention (Codex / Jules / Cursor / agents.md)

**Claim:** `AGENTS.md` is the cross-tool standing brief (“README for agents”). Official guidance converges on: short always-on file; build/test commands; conventions agents can’t infer; do-not rules; pair prose with linters/hooks; progressive disclosure via skills / nested files / pointers.

**Source:**
- [agents.md](https://agents.md/) (Agentic AI Foundation / Linux Foundation stewardship)
- OpenAI: [Customization](https://learn.chatgpt.com/docs/customization/overview.md), [Custom instructions with AGENTS.md](https://learn.chatgpt.com/docs/agent-configuration/agents-md.md); hierarchical note in [openai/codex](https://github.com/openai/codex/blob/main/codex-rs/core/hierarchical_agents_message.md)
- Anthropic: [CLAUDE.md](https://code.claude.com/docs/en/claude-md), [Best practices](https://code.claude.com/docs/en/best-practices)
- Cursor: [Rules](https://cursor.com/docs/rules)
- Google Jules: [Getting started](https://jules.google/docs/)

**Evidence:**
- **agents.md:** complementary to human README; popular sections include overview, build/test, code style, testing, security; nested files; closest file wins; Aider: `read: AGENTS.md` in `.aider.conf.yml`.
- **OpenAI:** “Keep it small… Pair `AGENTS.md` with infrastructure that enforces those rules: pre-commit hooks, linters, and type checkers… Codify recurring review feedback… If `AGENTS.md` starts getting too large, keep the main file concise and reference task-specific markdown” ([best practices](https://developers.openai.com/codex/learn/best-practices), [customization](https://developers.openai.com/codex/concepts/customization)). Same docs recommend a `code_review.md` referenced from `AGENTS.md` so review behavior stays consistent — the same progressive-disclosure shape as Matt’s review-time `CODING_STANDARDS.md`.
- **Anthropic:** target under ~200 lines; “Would removing this cause Claude to make mistakes?”; put multi-step / occasional material in skills; “Copying entire style guides” belongs in tooling/skills not always-on memory; hooks enforce deterministically where prose is only advisory.
- **Cursor:** AGENTS.md is the simple always-on alternative to `.cursor/rules`; best practices: “Avoid… Copying entire style guides: Use a linter instead”; provide concrete examples; reference files; add rules only after repeated mistakes; nested AGENTS.md with more-specific precedence.
- **Jules:** auto-reads root `AGENTS.md`; tip to keep it up to date.

---

### 6. Notable OSS / educator examples that work well with agents

**Claim:** Strong public examples separate (a) always-on agent brief, (b) on-demand coding/testing conventions with examples, and (c) architecture/ADR docs — rather than one mega style guide.

**Source / Evidence:**

| Example | Path / URL | Pattern |
| --- | --- | --- |
| **vercel/ai** | [AGENTS.md](https://github.com/vercel/ai/blob/main/AGENTS.md) | Long but structured agent brief: commands, import table, **Coding Standards** subsection (formatter/linter *names*, not full style essay), Zod/JSON forbidden patterns with rationale, error template with code, ADR index pointer, philosophies pointer, **Do Not** list, task-completion checklists. Nested `packages/ai/AGENTS.md` for package-local usage examples. |
| **openai/codex** | [AGENTS.md](https://github.com/openai/codex/blob/main/AGENTS.md) | Dense, machine-oriented do/don’t rules (module size caps, tagged lint conventions, sandbox env vars never-touch, test taste). Shows standards as checkable bullets + examples. |
| **Kent C. Dodds** | [kentcdodds.com/AGENTS.md](https://github.com/kentcdodds/kentcdodds.com/blob/main/AGENTS.md); [docs/agents/code-style.md](https://github.com/kentcdodds/kentcdodds.com/blob/main/docs/agents/code-style.md); [testing-principles.md](https://github.com/kentcdodds/kentcdodds.com/blob/main/docs/agents/testing-principles.md) | Explicit policy: “Keep it tiny and stable… Only update `AGENTS.md` to reference other docs… Put project callouts… in `docs/agents/`.” Style and testing are separate, example-rich files agents load when needed. |
| **hono / drizzle / trpc / effect** (spot-check) | root `AGENTS.md` / `CODING_STANDARDS.md` | No root AI standards files found (2026-08-09); drizzle/trpc have human `CONTRIBUTING.md` only. Not strong AI-standards exemplars. |
| **Theo / Josh Comeau / tt-ai** | searched | No primary `CODING_STANDARDS.md` / educator standards file found for this question; do not invent. |

---

### 7. Patterns that make standards work *with* AI (concrete, citable)

**Claim:** Across first-party sources, the durable pattern set is:

1. **Short always-on brief** (`AGENTS.md` / `CLAUDE.md`) — Matt dictionary, OpenAI “Keep it small,” Anthropic ~200 lines, Cursor avoid style-guide dumps, Kent “keep it tiny.”
2. **Put mechanical style in linters/formatters/typecheckers**, not prose — Cursor (“Use a linter instead”), OpenAI (pair AGENTS with hooks/linters; reserve formatting for CI), Matt code-review (“Skip anything tooling enforces”).
3. **Progressive disclosure** — style/architecture detail behind skills, nested AGENTS, or pointers (Matt progressive disclosure; Anthropic skills; OpenAI skills; Kent `docs/agents/*`).
4. **Falsifiable rules + examples (BAD/GOOD)** — sandcastle CODING_STANDARDS; vercel/ai error/Zod/JSON sections; openai/codex module-size and API-shape rules; Kent type/export rules.
5. **Domain vocabulary and seams elsewhere** — `CONTEXT.md` / ADRs / deep-module skills (Matt skills setup + Jeeves already); don’t restate in coding standards.
6. **Feedback loop** — add a line only after the agent errs twice (Matt AGENTS dictionary; OpenAI/Anthropic/Cursor “repeated mistakes”).
7. **Review-time load for heavy standards** — sandcastle template comment (standards cost tokens at review, not implementation); Jeeves `/code-review` already loads standards on demand.
8. **Prefer positive targets over bans** — Matt `writing-for-agents` negation warning; pair Never-rules with the desired behavior (OpenAI review-rules “safe path”).

---

### 8. What a CODING_STANDARDS.md would fill for Jeeves (gaps only)

**Claim:** Jeeves already covers harness ops (`AGENTS.md`), ubiquitous language (`CONTEXT.md`), structure/seams/ADRs (`ARCHITECTURE.md` + `docs/adr/`), and deep-module craft (`.agents/skills/codebase-design`). The missing piece `/code-review` wants is a **citeable, repo-local “how we write code” checklist** — concrete TypeScript/Node/React/Hono/SQLite conventions, forbidden patterns, testing taste, and example snippets — that is *not* always loaded into every session.

**Source:** This repo’s `AGENTS.md`, `CONTEXT.md`, `ARCHITECTURE.md`, `.agents/skills/code-review/SKILL.md`, `.agents/skills/codebase-design/SKILL.md`; compared to patterns in findings 2–7.

**Evidence (gap analysis):**
- `AGENTS.md` today: Cloud-agent run notes (ports, tests, `CURSOR_API_KEY`, `.jeeves/` gitignore behavior) — harness, not coding standards.
- `CONTEXT.md`: Card/Kind/Evaluation vocabulary — domain, not “prefer named exports.”
- `ARCHITECTURE.md` + ADRs: process shape, deep modules at system level — not day-to-day code taste.
- `codebase-design` skill: how to *design* deep modules when asked — not a review checklist of house rules.
- `/code-review` Standards axis today falls through to Fowler baseline unless `CODING_STANDARDS.md` / `CONTRIBUTING.md` exists — so agent-authored diffs are reviewed against generic smells, not Jeeves invariants (thin adapters, exchange-file harvest, worktree rules, Vitest-at-server-seams, etc.).

---

## Implications for Jeeves

- **Put in a future `CODING_STANDARDS.md` (on-demand / review-time):** falsifiable house rules with BAD/GOOD examples — module/adapter boundaries agents repeatedly blur; testing conventions (Vitest at server seams, what not to mock); TS/React preferences that differ from model defaults; forbidden patterns unique to this codebase (e.g. don’t give agents DB access; exchange-file rules; don’t invent domain synonyms already banned in `CONTEXT.md` by *reference*, not by copying the glossary); “done” verification commands beyond what `AGENTS.md` already states if they are standards rather than harness facts.
- **Leave in `AGENTS.md`:** always-true harness facts (ports, `npm test`/`npm run build`, key/env caveats, `.jeeves/` behavior) + **pointers** to `CONTEXT.md`, `ARCHITECTURE.md`, `CODING_STANDARDS.md`, and skills — Kent-style “tiny and stable.”
- **Leave in `CONTEXT.md`:** ubiquitous language only; don’t duplicate into coding standards beyond “use CONTEXT.md terms.”
- **Leave in `ARCHITECTURE.md` / ADRs:** structural decisions and deep-module map; coding standards may *cite* ADR numbers, not restate them.
- **Leave in `.agents/skills/codebase-design`:** how to deepen modules when designing; coding standards may say “prefer deep modules; see skill” rather than teaching Ousterhout.
- **Do not put in prose standards:** formatter/indent/quote rules — add tooling when needed (OpenAI/Cursor/Matt: skip what linters enforce). Jeeves currently has no lint script; if style must be enforced, prefer introducing a linter over a long style essay.
- **Optional best example pointers:**
  - Matt sandcastle standards: https://github.com/mattpocock/sandcastle/blob/main/.sandcastle/CODING_STANDARDS.md
  - Matt review template (load-at-review idea): https://github.com/mattpocock/sandcastle/blob/main/src/templates/sequential-reviewer/CODING_STANDARDS.md
  - vercel/ai AGENTS coding-standards section: https://github.com/vercel/ai/blob/main/AGENTS.md
  - Kent tiny AGENTS + `docs/agents/code-style.md`: https://github.com/kentcdodds/kentcdodds.com/blob/main/AGENTS.md
  - OpenAI customization: https://learn.chatgpt.com/docs/customization/overview.md
  - Cursor rules (anti–style-guide dump): https://cursor.com/docs/rules
  - agents.md standard: https://agents.md/

---

## Sources

- https://github.com/mattpocock/skills (AGENTS.md, CLAUDE.md, CONTEXT.md, skills/engineering/code-review/SKILL.md, docs/engineering/code-review.md, skills/productivity/writing-for-agents/SKILL.md)
- https://github.com/mattpocock/sandcastle (AGENTS.md, CLAUDE.md, `.sandcastle/CODING_STANDARDS.md`, `src/templates/sequential-reviewer/CODING_STANDARDS.md`, `src/templates/parallel-planner-with-review/CODING_STANDARDS.md`)
- https://github.com/mattpocock/dictionary-of-ai-coding (dictionary/AGENTS.md.md, dictionary/Progressive%20disclosure.md, CLAUDE.md)
- https://www.aihero.dev/a-complete-guide-to-agents-md
- https://www.aihero.dev/skills-code-review
- https://github.com/mattpocock/agent-rules-books (fork of ciembor/agent-rules-books)
- https://github.com/mattpocock/skills/issues/558 (AGENTS.md vs CLAUDE.md harness note)
- https://agents.md/
- https://developers.openai.com/codex/learn/best-practices
- https://developers.openai.com/codex/concepts/customization
- https://github.com/openai/codex/blob/main/AGENTS.md
- https://code.claude.com/docs/en/claude-md
- https://code.claude.com/docs/en/best-practices
- https://cursor.com/docs/rules
- https://jules.google/docs/
- https://github.com/vercel/ai/blob/main/AGENTS.md
- https://github.com/kentcdodds/kentcdodds.com/blob/main/AGENTS.md
- https://github.com/kentcdodds/kentcdodds.com/blob/main/docs/agents/code-style.md
- https://github.com/kentcdodds/kentcdodds.com/blob/main/docs/agents/testing-principles.md
- Spot-checks (no root AGENTS/CODING_STANDARDS): honojs/hono, drizzle-team/drizzle-orm, trpc/trpc, Effect-TS/effect, total-typescript/total-typescript-book
- Local Jeeves: `/workspace/AGENTS.md`, `/workspace/CONTEXT.md`, `/workspace/ARCHITECTURE.md`, `/workspace/.agents/skills/code-review/SKILL.md`, `/workspace/.agents/skills/codebase-design/SKILL.md`
