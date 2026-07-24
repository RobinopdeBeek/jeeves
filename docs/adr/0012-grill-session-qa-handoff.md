# Grill session is a Q&A extract, not the transcript or a synthesis

The durable hand-off from Grill → Spec is a **Grill session** markdown artifact (`kind: grill`): resolved questions and answers (near-verbatim substance, clarifications collapsed into the settled pair), any still-open questions, and a short list of glossary/ADR paths updated during the interview. It is produced by a host LLM **extract** on advance (not a `runs` row), not by treating the live chat transcript as the Spec input and not by synthesizing a problem-statement / assumptions / readiness summary.

The mutable `UIMessage[]` **transcript** remains a separate artifact for resume and debug. The done Grill tab shows only the Grill session. The artifact is read-only after harvest; a failed extract blocks advance; empty optional sections are omitted. Bare multiple-choice answers are expanded to the chosen option text without dumping full option lists.

## Considered options

- **Transcript as the grill artifact** — rejected: full of process narration, tool calls, and permission chrome that Spec and the done tab should not consume.
- **Synthesizing `grill-summary`** (problem statement, assumptions, readiness) — rejected: paraphrases and shortens decisions the interview already settled; Spec needs faithful Q&A.
- **Structured Q&A written during the live grill** — deferred: nicer long-term, but a larger change to the chat skill; extract-on-advance reuses the planned hand-off seam.

## Consequences

- Rename/replace the planned `grill-summary` host step with a Grill session extract prompt (extract-only, never summarize).
- Spec, `to-tasks`, and lineage consume the Grill session; they do not treat the transcript as the hand-off.
- `artifact_lineage` links Grill session ← transcript (and onward to Spec).
