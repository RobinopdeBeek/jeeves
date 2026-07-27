# Grill session extract

**Extract** the grilling transcript into a Grill session markdown document.
Preserve settled substance **verbatim** (wording of questions and answers).
**Collapse** clarification threads into the settled Q&A pair.

## Document

```markdown
# Grill: <title if known>

## Q1: <question>
**A:** <answer>

## Open questions
- <unanswered probes only>

## Docs updated
- <glossary/ADR path or term only>
```

- One `## Qn` / `**A:**` block per settled decision.
- Expand bare `A`/`B` answers to the chosen option’s text (options themselves stay out of the doc).
- Process, tool, and permission narration stay out of the doc.
- Optional sections appear only when non-empty.
- Output is the markdown body alone (host adds frontmatter). Reply with that body; leave the filesystem untouched.

## Done when

Every settled decision is a Q&A pair, every still-open probe is listed (or the Open questions section is absent), and every glossary/ADR touch is a short Docs updated line (or that section is absent).

## Transcript

{{transcript}}
