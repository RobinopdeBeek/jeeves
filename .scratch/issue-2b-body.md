## Parent

#1

## What to build

Wire the **kind decision** into the card view and board navigation. Rename **+ Add issue** to **+ Add card** everywhere.

On Backlog cards, the card view footer shows **Grill me →** (primary) and **Implement now →** (outline) on the right, Delete on the left. Both decide buttons are disabled when title is empty; enabled once the user has named the card. Clicking either calls `POST /api/cards/:id/decide` and updates local state with the returned card + steps.

After deciding, the card view becomes multi-tabbed. **Tab visibility:** Info always visible; any step with status `pending` is hidden. **Active tab after decide** — jump using this priority (reuse for future step hand-offs):

```
activeStep = first needs-user
  ?? first ai-working
  ?? first pending
  ?? last work step
```

Feature path after decide: Info + Grill tabs visible (PRD/Tasks hidden). Standalone path: Info + Plan tabs visible (Implement/AI Review hidden). **Grill tab** is a chat-layout shell (message area + composer chrome, no live AI). **Plan tab** is a run-log layout shell showing queued status (no real execution). Title and description remain editable on the Info tab after decide. Delete still recovers from a wrong path (kind decision is irreversible).

Board refetches the card list on mount so cards appear in Define or Implement when navigating back (important on mobile where the user may still be on the Backlog column tab). Card tiles stay plain in this slice — pipeline display on tiles arrives in the companion issue.

## Acceptance criteria

- [ ] Board button and column chrome say **+ Add card**, not "issue"
- [ ] Backlog card footer: Delete left; **Implement now →** and **Grill me →** right
- [ ] Decide buttons disabled when title is blank; enabled with a title
- [ ] **Grill me →** makes card a feature in Define column; lands on Grill tab
- [ ] **Implement now →** makes card a standalone task in Implement column; lands on Plan tab
- [ ] Tab bar hides all `pending` steps; shows Info always
- [ ] Grill tab renders chat shell; Plan tab renders queued run-log shell
- [ ] Title/description auto-save still works after kind decision
- [ ] Board refetches cards on mount after returning from card view
- [ ] Card appears in correct column on board (plain tile is fine)

## Blocked by

#2
