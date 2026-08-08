# Simple rework flow

> Replaces the planned task Round N loop (“Implement changes →” back to Implement).
> No rounds. No task types. Change Requests stay side-panel items, run as one in-Review batch.

## Goal

After QA, most follow-ups are small, dirty bullets — not a new Plan → Implement → AI Review cycle.
Rework stays in **Human Review**, feels quick and iterative, and still has a thin planning + review spine so messy CRs don’t get applied blind.

## UX

1. Keep the **Request changes** side panel (add / edit / delete; optional `+` from eval findings).
2. User finishes the CR list and clicks **Implement changes →**.
3. Card **stays in the Review column**. Tile/step shows a loading state: **Reworking…**
4. The Review tab hides the normal eval + side panel. It shows a **todo list** in the middle (Cursor-style): one row per CR, with live status as the batch runs.
5. When the batch finishes, refresh the evaluation, clear the open CR list (consumed items remain as history), and restore the normal Review UI.

## Execution spine (inside Review)

One batch run over the open CR list. Not a board Task per CR. Not a column hop.

```
Implement changes →
  → plan-rework          (one skill, whole list)
  → apply-CR × N         (fresh subagent per CR; serial by default)
  → code-review          (one pass over all CR commits)
  → refresh eval         (Prepare Eval again on the new tip)
  → back to Review UI
```

### 1. plan-rework

Single skill over the whole open CR list.

- Normalize quick-and-dirty bullets into structured handoffs (title, intent, acceptance, files/seams, notes).
- Do light planning and doc/lookup only where a CR needs it.
- Emit an **ordered** list ready for subagents.
- May **suggest** which CRs can safely run in parallel (shared files / ordering deps). Host may ignore and stay serial.

Output is structured handoff data, not free prose only — each apply-CR subagent receives one prepared item.

### 2. apply-CR (per item)

- Fresh subagent per CR (clean context).
- **Default: sequential** in plan-rework order.
- Parallel only when plan-rework marked a safe group **and** the host chooses to honor it.
- Each successful CR commits on the card’s Review worktree / branch tip.

**Partial failure:** stop the batch. Keep commits for CRs that already succeeded. Leave the failed CR and any not-yet-started CRs **open** for retry. Do not consume the whole list on partial success.

### 3. code-review

One code-review pass over the combined CR work (not per CR). Catches cross-CR breakage. Rework from findings can stay in this step or be a tight follow-up — keep it thinner than Implement-column AI Review.

### 4. refresh eval

Re-run **Prepare Eval** (or a dedicated refresh skill with the same outcome) on the new tip. Prefer honest full refresh over vague “patch where needed.” Then return to the normal Review UI with an empty open CR list.

## Worktree

While the card is in Review, **keep the worktree** (already needed for the preview server).
Each CR batch commits on that tip — same branch, longer-lived worktree for the Review stay — instead of tearing down and recreating an Implement-column worktree per round.

## Explicit non-goals (YAGNI)

- **No rounds** — no Round 2 badge, no round partition as the user-facing rework model. History can be decision + consumed CRs + runs + eval SHA (schema cleanup can follow).
- **No task types** (`simple` / `complex` / bug / refactor) — CRs are the simple path; agents handle occasional harder items in this same pipe.
- **No column hop** back to Implement for normal CR batches.
- **No board Task per CR** — the side-panel list *is* the bundle; the batch is the run.

Escape hatch later if needed (“send back to Implement” for a true rewrite) — not part of v1.

## Reasoning

Usually after a bigger feature I walk the QA checklist and find many small fixes, rarely a big miss. I write them as bullets. Sending the card back through Plan → Implement → AI Review with a new worktree is overkill. Keeping the Review worktree and running a CR batch in place matches how I already work locally: refine the list, apply, glance at review, re-check the eval.
