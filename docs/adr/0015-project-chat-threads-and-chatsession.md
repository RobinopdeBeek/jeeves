# Project-scoped Chat Threads and ChatSession descriptor

Project Chat conversations are first-class **Chat Threads** owned by the Project — not synthetic Cards or step-bound chat keys. Step chats (Grill, Spec assist, Tasks assist) and Project Chat Threads share one warm ACP pool via a **ChatSession** descriptor resolved at the WebSocket boundary: opaque server-built id (`card:…` / `thread:…`), cwd, nullable opening prompt, optional pinned model (`agent --model` at spawn; step chats omit → CLI default), load/save transcript, mutability assert, status notify, permission policy, and optional frame/`onTurnComplete` hooks. The warm registry and `AcpBridge` stay card-agnostic — they only see the opaque id and injected policies. A null opening prompt with empty history warms ACP without auto-firing an agent turn (user-first Project Chat). Changing a Chat Thread's pinned model closes that warm process so the next open respawns with the new `--model`.

## Considered Options

- **Synthetic Card per Chat Thread** — rejected: would overload Card/step/round vocabulary, force fake pipeline steps, and couple freeform chat to board advance rules.
- **Registry keyed by client-supplied `(cardId, stepKey, round)` triples** — rejected: clients could collide warm slots; Project Chat has no step/round.
- **Separate warm pools for step chat vs Project Chat** — deferred: one shared cap keeps process pressure bounded until measured otherwise.
