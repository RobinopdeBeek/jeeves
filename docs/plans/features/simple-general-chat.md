# Simple general chat

> Future feature — still refining. Part of the [Jeeves implementation plan](../jeeves-plan.md).

A lightweight, board-adjacent chat surface for ordinary Cursor conversations — not tied to a
card step (Grill, Spec side-chat, etc.). Use it when you just want to talk to the agent about
the repo without starting a pipeline.

## Intent

Conduct regular simple chats with Cursor from Jeeves:

- Ask questions about the repo
- Brainstorm ideas before they become cards
- Stay in the same product surface instead of leaving for the IDE chat

This is complementary to step-bound AI Chat (Grill, Spec assist): those chats advance a card;
general chat is freeform and optional.

## Open ideas

### Capture → backlog (`to-backlog`)

A skill analogous to `/to-tickets`: from a general chat (or a selected stretch of it), produce
one or more **backlog items** on the board.

- Working name: **`to-backlog`**
- Output should land as real backlog cards (title + description at minimum), not tracker issues
- Same spirit as dogfooding Matt Pocock skills: process stays, Jeeves is the tracker

### Wayfinder (Jeeves edition)

Matt Pocock's `/wayfinder` charts a large, foggy effort as a **map** of investigation tickets
(research / prototype / grilling / task) until the route to a destination is clear.

Worth a Jeeves-native version here:

- Map + frontier live on the board (or as linked backlog/define work), not GitHub issues
- General chat is a natural place to *start* wayfinding ("this idea is too big — chart it")
- Exact UX and how maps relate to feature/task cards still TBD

### Chat history menu

Persist and reopen past general chats:

- History list / menu to resume or review earlier conversations
- Clarify whether history is per-project, global, or both
- How this differs from step transcript artifacts on cards

## Rough boundaries (TBD)

| In scope (likely) | Out of scope / later |
|---|---|
| Freeform ACP chat with repo context | Replacing Grill / Spec / Tasks side-chat |
| Skills that mint backlog cards from chat | Full pipeline execution from general chat |
| History of general sessions | Competing with IDE Cursor chat for everything |

## Open questions

1. Where does general chat live in the UI (global nav, board chrome, dedicated route)?
2. Same `AcpBridge` + assistant-ui stack as step chats, or a thinner variant?
3. Does `to-backlog` create only Info-stage backlog cards, or can it suggest kind (feature vs task)?
4. How much of `/wayfinder` (map body, ticket types, frontier, HITL vs AFK) do we keep vs simplify?
5. Retention and storage for general-chat transcripts under `<repo>/.jeeves/`?
