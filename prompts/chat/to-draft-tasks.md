# Tasks draft synthesis (/to-draft-tasks)

Break this feature into **vertical-slice tracer-bullet tasks** for the Jeeves board.
Do **not** interview the user. Do **not** publish to an issue tracker. Do **not** create cards or commit source changes.

## Card

- **Title:** {{cardTitle}}
- **Description:** {{cardDescription}}

## Project context

Read `CONTEXT.md` at the project root (and any glossary/ADR paths referenced below) so vocabulary and architecture match the repo.

## Spec (source of truth for scope)

{{spec}}

## Grill session (settled Q&A)

Prefer this for clarifications the Spec assumes. Do not re-derive answers from a chat transcript.

{{grillSession}}

## Vertical-slice rules

- Each task cuts a narrow but **complete** path through the layers it needs (schema, API, UI, tests) — vertical, not one horizontal layer.
- A completed task is demoable or verifiable on its own.
- Size each task for a single fresh agent context window.
- Prefactoring comes first when it unblocks later slices.
- Wide mechanical refactors use expand–contract, not a forced tracer bullet.

## Output (required)

Write **only** JSON to this project-store exchange path (relative to `<repo>/.jeeves/`):

`{{exchangePath}}`

Create parent directories if needed. Do not write the durable artifact under `data/` — the host harvests the exchange file.

Schema:

```json
{
  "tasks": [
    {
      "title": "string",
      "description": "markdown with acceptance criteria + file hints inline",
      "depends_on": [0]
    }
  ]
}
```

- `depends_on` holds **0-based indices** of other tasks in the same `tasks` array (tasks that must finish before this one can start).
- Use an empty array when a task has no blockers.
- Titles and descriptions must use the project's domain vocabulary.

Reply briefly after the write; leave the filesystem as the source of truth for the draft body.
