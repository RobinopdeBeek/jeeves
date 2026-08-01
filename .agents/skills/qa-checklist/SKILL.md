---
name: qa-checklist
description: Write a Spec-led funnel QA checklist for a PR or slice (happy paths → edge cases → polish).
disable-model-invocation: true
---

# QA Checklist

Write a **funnel** checklist a human can run against a ready PR or slice: top items prove the feature works; lower tiers deepen confidence and can be skipped when the top is enough.

**Spec-led**: the Spec (issue body, acceptance criteria, user stories, and other leading docs) decides *what* to check. The PR and code decide *how* to exercise it — routes, controls, setup — not whether a Spec behaviour earns a checkbox.

Every item is a **script**: the tester follows Action without deciding how. User should be doing, not thinking.

## Process

### 1. Gather sources

Resolve every input the user named (slice number, PR URL, issue, local path). Then complete the set:

1. **Parent slice + (sub)slices** on GitHub matching the slice (e.g. Slice 7 → 7, 7A, 7B…). Prefer issue bodies over titles.
2. **PR** — description, linked issues, and the diff (`gh pr view` / `gh pr diff`) when a PR is named or findable for the slice.
3. **Leading docs** the Spec points at (ADR, build-order, CONTEXT, prototype) only when the Spec depends on them for behaviour.

If no Spec source turns up, ask where it lives before drafting.

Done when: every named slice/PR is fetched, and each (sub)slice for that parent is either read or explicitly marked out of this PR's scope.

### 2. Extract the behaviour surface

From Spec sources only, list the observable behaviours under test — user stories, acceptance criteria, demo paths, and in-scope seams a human can see. Note Out of Scope so later slices stay off the list.

Use the PR/diff only to map each behaviour to a concrete exercise path (which tab, button, fixture, repo). Skip behaviours with no shipped UI/API the tester can hit.

Done when: every in-scope Spec behaviour has either a checklist candidate or a one-line reason it is not manually QAable (pure CI seam, docs-only, unshipped control, etc.).

### 3. Write the funnel

Start with a short **Setup** when shared preconditions would otherwise repeat (which card state, which app URL). Then emit checkbox items in this fixed tier order:

#### Happy path(s)

The default success journeys. A green top of the funnel means "it basically works."

#### Edge cases

Failure modes, validations, races, empty states, retries, and Spec'd non-happy branches.

#### Polish

Narrow, low-risk, or cosmetic leftovers (tooltips, narrow-viewport stacking, copy). The tester may stop before this tier.

Within each tier, order critical path before peripheral.

Done when: every manually QAable Spec behaviour appears in exactly one tier, every item is a complete Action/Expected script, Out of Scope / unshipped behaviours are absent, and the checklist file is written (see Output).

## Output

Write the full checklist to `.scratch/qa/<slug>.md` (create the folder if needed). Slug from the slice/PR (e.g. `slice-7`, `slice-7-pr-32`). Also show the checklist in chat and link the path.

## Item shape

Every checkbox uses this form — including happy paths (no separate **How:** lines anywhere):

```markdown
- [ ] <short label>
  - **Action:** <numbered or sequential steps the tester performs — named UI labels, exact values>
  - **Expected:** <what they must observe when done>
```

Rules for **Action**:

- Spell every click, field, and value; the tester should not invent a path.
- When the case is a failure, pick **one** concrete reproduce method and script it fully — never a menu of alternatives ("e.g. kill ACP / bad exchange").
- Prefer a deterministic setup (rename a required file, use two browser profiles, enter a known-bad graph) over "wait for a real fail."

Prefer Spec vocabulary (Fan-out, tip, awaiting) over implementation jargon when both name the same thing.
