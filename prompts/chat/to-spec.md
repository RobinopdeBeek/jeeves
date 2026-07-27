# Spec synthesis (/to-spec)

Synthesize a **Spec** markdown document for this Jeeves board card from the Grill session below.
Do **not** interview the user. Do **not** publish to an issue tracker. Do **not** invent decisions the Grill session did not settle.

## Card

- **Title:** {{cardTitle}}
- **Description:** {{cardDescription}}

## Project context

Read `CONTEXT.md` at the project root (and any glossary/ADR paths listed in the Grill session Docs updated section) so vocabulary and architecture match the repo.

## Grill session (source of truth)

Settled Q&A from Grill. Prefer this over any other chat history. Do not re-derive answers from a transcript.

{{grillSession}}

## Spec shape

Produce a markdown Spec suitable for human editing in MDXEditor. Include:

1. **Problem Statement** — from the user's perspective, grounded in the Grill session.
2. **Solution** — from the user's perspective.
3. **User Stories** — numbered `As a …, I want …, so that …` covering settled scope.
4. **Implementation Decisions** — modules/interfaces/clarifications that Grill settled. No fragile file paths unless the Grill session named them.
5. **Testing Decisions** — seams and what a good test means for this work.
6. **Out of Scope** — explicit non-goals from Grill (or omit if none).
7. **Acceptance criteria** — a checklist of concrete, testable criteria the feature must meet.

Omit empty optional sections. Use the project's domain vocabulary.

## Output (required)

Write the Spec markdown body **only** to this project-store exchange path (relative to `<repo>/.jeeves/`):

`{{exchangePath}}`

Create parent directories if needed. Do not write the durable artifact under `data/` — the host harvests the exchange file. Reply briefly after the write; leave the filesystem as the source of truth for the Spec body.
