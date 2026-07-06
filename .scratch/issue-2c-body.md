## Parent

#1

## What to build

Make the board a pipeline monitor at a glance. **CardTile** gains post-decide chrome driven entirely from enriched `steps` on the card API response — the client never imports pipeline definitions.

**Segmented progress bar** shows steps in the **current column** only (steps whose stage matches the card's column). Below it, a **current-step label** with status icon, derived using the shared active-step priority:

```
activeStep = first needs-user
  ?? first ai-working
  ?? first pending
  ?? last work step
```

**Feature flag icon** when `kind === feature`. **Needs-you border** when any work step is `needs-user` OR `column === review` (so a feature in Define with Grill `needs-user` surfaces before chat is wired).

Extract shared client helpers for active-step resolution, tab visibility, and tile derivation from prototype logic (`board-shared.js`) rather than duplicating rules inline.

## Acceptance criteria

- [ ] Post-decide tiles show a segmented bar for current-column steps only
- [ ] Current-step label with status icon appears below the bar
- [ ] Feature cards show a flag icon on the tile
- [ ] Tiles with any `needs-user` work step show a needs-you border
- [ ] Tiles in Review column show a needs-you border
- [ ] Backlog / undecided cards remain plain (no false pipeline chrome)
- [ ] Tile rendering uses API `steps` data only — no client-side pipeline imports

## Blocked by

#2
