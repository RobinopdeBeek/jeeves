# Chat attachment sidecars and Cursor text-resource override

User-turn attachments for Project Chat and step chats (Grill / Spec / Tasks) are stored as **on-disk sidecars**, not as base64 `data:` URLs inside `transcript.json`. The composer uploads bytes via REST (`POST …/attachments`) and the WebSocket turn carries only opaque pointers (`jeeves-attachment://…`). The server still materializes any legacy/live `data:` URL as a safety net before persist, but new clients never put base64 in the transcript. Legacy transcripts with inline `data:` remain readable for resume/display.

## Pointer scheme

- Project Chat: `jeeves-attachment://chat/<threadId>/<attachmentId>`
  → `.jeeves/data/chat/<threadId>/attachments/<attachmentId>-<safeName>`
- Step chat: `jeeves-attachment://step/<cardId>/<stepKey>/<attachmentId>`
  → `.jeeves/data/cards/<cardId>/chat-attachments/<stepKey>/<attachmentId>-<safeName>`

Hard-delete of a Chat Thread `rmSync`s the thread directory (attachments included). Card hard-delete removes `cards/<cardId>/` (including `chat-attachments/` and the card Info library folder). Serve routes stream bytes with path containment. This is distinct from execution-engine `kind: "attachment"` (failure diagnostics) and from the **card Info library** (Phase 2, shipped): bytes at `data/cards/<cardId>/attachments/<id>-<safeName>`, metadata + per-file `instruction` in SQLite `card_attachments`, REST at `/api/cards/:id/attachments`. Library files must not use `jeeves-attachment://` pointers.

## Cursor `embeddedContext: false` override

ACP requires clients to withhold `type: "resource"` when `promptCapabilities.embeddedContext` is false. Cursor Agent CLI still advertises that flag as false, but a live probe showed markdown `resource` blocks are accepted and used ([research note](../research/acp-prompt-capabilities-embedded-context.md)). Jeeves therefore offers a **high-confidence text allowlist** (`text/*`, `application/json`, `application/xml`, plus common text extensions) and converts those to `resource.text` even when the advertisement is false. Images remain gated on `image`; audio on `audio`. PDF / bare `application/octet-stream` stay closed until probed.

## Consequences

- New turns upload via REST then send pointers on the WS — `transcript.json` never grows base64 payloads.
- Chips reload via HTTP serve URLs derived from pointers.
- Re-probe Cursor on agent upgrades — advertisement and runtime acceptance can diverge again.
- Card-library attachments (`CardAttachmentStore`, `card_attachments` table, Info UI) are a separate owner: HTTP `/api/cards/:id/attachments`, not chat-turn pointers. Same “bytes on disk” method, different owner.
