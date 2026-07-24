# Prototype as artifact

> Future feature — still refining.

Prototypes often feed Spec and stay useful as reference while building. Build them in Cursor (design mode / `/prototype`); Jeeves should still hold the result in the card's artifact list.

Must be attached before Spec generation. Same pattern may apply to screenshots, PDFs, Excels, etc. — all in ArtifactStore, most relevant in Define.

## Option 1 — Generic artifact attacher

- Attach any artifact to a card anytime (button bar), not only Grill/Spec
- Can add in Backlog so Grill starts with it, or mid-Grill
- Prototype is just one artifact type among many

## Option 2 — Prototype as task kind

- Separate prototype card/task → Implement as `needs-user` until prototype is referenced
- Or: Jeeves seeds the first prototype + Cursor link; already in ArtifactStore; iterate in Cursor

Implies richer task kinds (also useful for `/wayfinder`):

- `ai-implement` — current default
- `user-prototype` — human work; not AI-picked-up (Scrum-style "in progress")
- `ai-research` — AI runs `/research` only (no plan/implement/review)
