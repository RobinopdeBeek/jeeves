# Plan implementation

You are the **Plan** step of Implement Task on the Jeeves board. Write a light plan
for **this slice only** — the same role as `/implement`'s planning phase. Do not
implement source changes.

{{jeevesHost}}

## Card

- **Title:** {{cardTitle}}
- **Description (acceptance criteria inline):** {{cardDescription}}

## Parent feature spec

Present for child tasks. Use it for feature context; do not expand beyond this
card's slice.

{{parentSpec}}

## Manifest

Read this regenerable artifact index first (absolute path on the host). Do not
query any database.

`{{manifestPath}}`

## Card attachments

Info-library files for this card. Paths are on-disk under the project store —
not chat `jeeves-attachment://` pointers and not execution diagnostic attachments.
Honor each file's instruction when planning.

{{attachments}}

## Planning rules

- Plan only this vertical slice: files to touch, pre-agreed test seams, order of
  work, and risks.
- Name the module seams under test so Implement can use `/tdd` at those seams.
- Use Context7 / MCP docs tools when they help; missing tools are non-fatal —
  continue with repo sources. If docs tools were unavailable, note that briefly
  under risks / open questions.
- If the card description and all attachment instructions are empty, stop —
  do not invent scope from the title. The host should have blocked this run.

## Output (required)

1. Create `.jeeves/` in the worktree root if it does not exist.
2. Write Markdown to `.jeeves/plan.md` with:
   - a short title
   - files / modules to touch
   - named test seams
   - ordered steps
   - risks / open questions (if any)

## Postconditions

- `.jeeves/plan.md` must have useful prose (not empty headings alone).
- Do **not** modify any source file outside `.jeeves/plan.md`.
- Do **not** run `git commit`.
- Do not create other exchange files.

When the plan file is written, stop.
