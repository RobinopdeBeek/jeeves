---
name: qa-checklist
description: Write a Spec-led funnel QA checklist for a PR or slice (happy paths → edge cases → polish).
disable-model-invocation: true
---

# QA Checklist

Write a **funnel** checklist a human can run against a ready PR or slice: top items prove the feature works; lower tiers deepen confidence and can be skipped when the top is enough.

**Spec-led**: the Spec (issue body, acceptance criteria, user stories, and other leading docs) decides *what* to check. The PR and code decide *how* to exercise it — routes, controls, setup — not whether a Spec behaviour earns a checkbox.

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

Use the PR/diff only to map each behaviour to a concrete exercise path (which tab, button, fixture, repo).

Done when: every in-scope Spec behaviour has either a checklist candidate or a one-line reason it is not manually QAable (pure CI seam, docs-only, etc.).

### 3. Write the funnel

Emit markdown checkboxes in this fixed tier order:

#### Happy path(s)

The default success journeys. One item = one observable action + expected result. A green top of the funnel means "it basically works."

#### Edge cases

Failure modes, validations, races, empty states, retries, and Spec'd non-happy branches. When how to reach the case is unclear from the happy UI alone, add a short **How:** line with setup/reproduce steps.

#### Polish

Narrow, low-risk, or cosmetic leftovers (tooltips, narrow-viewport stacking, copy). The tester may stop before this tier.

Within each tier, order critical path before peripheral.

Done when: every manually QAable Spec behaviour appears in exactly one tier, every edge case that needs setup has **How:**, and Out of Scope behaviours are absent.

## Item shape

- `[ ]` + imperative check + expected result — e.g. `Click **Implement →** with a valid DAG → children appear on the board; Tasks becomes awaiting`.
- Edge **How:** only when needed — concrete steps, not theory.
- Prefer Spec vocabulary (Fan-out, tip, awaiting) over implementation jargon when both name the same thing.
