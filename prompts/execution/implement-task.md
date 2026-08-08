# Implement task

You are the **Implement** step of Implement Task on the Jeeves board. Follow the
plan. Use `/tdd` at the pre-agreed seams. Commit incrementally on this card
branch. Do **not** run `/code-review` — that is the next step (AI Review).

## Card

- **Title:** {{cardTitle}}
- **Description (acceptance criteria inline):** {{cardDescription}}

## Plan

Follow this harvested plan. Re-plan only when the Plan step re-queues — not for
Implement-only rework.

{{plan}}

## Manifest

Read this regenerable artifact index first (absolute path on the host). Do not
query any database.

`{{manifestPath}}`

## Card attachments

Info-library files for this card. Paths are on-disk under the project store —
not chat `jeeves-attachment://` pointers and not execution diagnostic attachments.
Honor each file's instruction when implementing.

{{attachments}}

## Implementation rules

- Follow the plan for **this slice only**.
- Use `/tdd` at the named seams: red → green → next seam.
- Run typecheck and tests as you go; fix failures before moving on.
- Commit incrementally with clear messages on the card branch.
- Prefer vocabulary from `CONTEXT.md` and respect ADRs in the target repo.
- Do not hunt the project store or SQLite for inputs — everything you need is
  injected above (plus the manifest paths).
- Do **not** run `/code-review` or produce a review artifact.

## Postconditions

- At least one commit on the card branch.
- Working tree clean when you exit (no uncommitted source changes).
- Do not leave undeclared exchange files outside what the host harvests.

When the work is committed and the tree is clean, stop.
