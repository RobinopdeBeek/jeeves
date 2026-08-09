---
name: super-review
description: Parallel thermo-nuclear quality + architecture deepening review of a user-defined change set, then grill only the decisions.
disable-model-invocation: true
---

# Super-Review

Two-axis review of a user-defined **change set** — the strict reviewer and the opportunistic refactorer, in parallel:

- **Quality** — follow [thermo-nuclear-code-quality-review](../thermo-nuclear-code-quality-review/SKILL.md): ambitious maintainability, code judo, spaghetti growth, file-size, boundary cleanliness.
- **Architecture** — follow [improve-codebase-architecture](../improve-codebase-architecture/SKILL.md) scoped to the change set: deepening opportunities it surfaces or sits inside.

Both axes run as **parallel sub-agents** so they don't pollute each other's context. This skill aggregates a brief overview, then starts [grill-with-docs](../grill-with-docs/SKILL.md) on the **decision** queue only.

## Process

### 1. Pin the change set

Resolve whatever the user named into one concrete diff and commit list. Common shapes:

- **GitHub PR** (URL or number) — `gh pr diff <n>` and `gh pr view <n> --json commits,baseRefName,headRefName` (works even when the PR tip is not local `HEAD`).
- **Base ref** (`main`, a SHA, tag, `HEAD~5`, …) — `git diff <base>...HEAD` and `git log <base>..HEAD --oneline`.
- **Explicit range** (two refs / SHAs) — three-dot diff and log across that range.

If they named nothing, ask. Confirm the change set resolves and the diff is non-empty before spawning sub-agents.

**Done when:** one change set is pinned (how it was resolved + the exact diff/log commands) and that diff is non-empty.

### 2. Spawn both sub-agents in parallel

Send a single message with two `Agent` tool calls. Use the `general-purpose` subagent for both. Each prompt includes the pinned change set (diff command, commit list, and PR identity if any) and a **context pointer** to its skill file — the sub-agent reads that file; this skill stays the orchestrator only.

**Quality sub-agent prompt** — include:

- The change set's diff command and commit list.
- "Read `.agents/skills/thermo-nuclear-code-quality-review/SKILL.md` in full and apply it to this change set (behavior-preserving quality audit)."
- The brief: "Return findings ordered by that skill's priority. For each finding: severity (blocker / high / note), files, the problem in one or two sentences, and the preferred remedy. Flag missed code-judo moves explicitly. Under 500 words."

**Architecture sub-agent prompt** — include:

- The change set's diff command and commit list.
- "Read `.agents/skills/improve-codebase-architecture/SKILL.md` and `.agents/skills/codebase-design/SKILL.md`. Run its Explore process scoped to modules the change set touches or whose seams it stresses — opportunistic deepening grounded in this change."
- "Stop after presenting candidates (that skill's step 2). Return the candidates here for the parent to classify."
- The brief: "Return each candidate with Files, Problem, Solution, Benefits (locality / leverage / tests), Recommendation strength (`Strong` / `Worth exploring` / `Speculative`), plus a Top recommendation. Mark ADR conflicts. Use CONTEXT.md domain terms and codebase-design vocabulary (module, interface, depth, seam, adapter, leverage, locality). Under 500 words."

**Done when:** both sub-agents have returned.

### 3. Aggregate, then build the decision queue

Present a **brief overview** under `## Quality` and `## Architecture` — compressed from the sub-agent reports, axes kept separate. Do not merge or rerank across axes.

Then classify every finding into exactly one bucket:

- **Overview-only** — the remedy is clear without a human choice (local cleanup, obvious extract, direct violation with one fix). Remains in the overview.
- **Decision** — a human must choose: which deepening candidate to pursue, whether to take a code-judo reframe, waive a presumptive blocker, reopen an ADR, or accept scope/timing tradeoffs. These form the grill queue.

List the grill queue under `## Decisions` (empty list is allowed). One line per item: what must be decided, and your recommended answer.

**Done when:** every finding from both axes is in exactly one bucket, and `## Decisions` contains only human choices.

### 4. Grill the decisions

If `## Decisions` is empty, stop after the overview — say no decisions remain.

Otherwise start [grill-with-docs](../grill-with-docs/SKILL.md) (`/grilling` + `/domain-modeling`) with the decision queue as the plan under test. One question at a time. Questions cover only that queue; look up facts in the codebase.

**Done when:** every decision-queue item is resolved, or the user stops the grill.

## Why two axes

A change can look clean on one axis and wrong on the other:

- Locally tidy code that leaves shallow modules in place → **Quality quiet, Architecture loud.**
- A bold deepening that papers over spaghetti or a 1k-line file → **Architecture bold, Quality fails.**

Reporting them separately stops one axis from masking the other. The grill exists for decisions; clear fixes do not need an interview.
