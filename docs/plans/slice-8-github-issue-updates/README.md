# Slice 8 GitHub issue updates (post PR #54)

Cloud agent tokens cannot `PATCH` issues on this repo (`Resource not accessible by
integration`). Bodies below are the intended replacements for #55–#64 after reviewing
[PR #54](https://github.com/RobinopdeBeek/jeeves/pull/54).

## Apply locally

Needs a token with `issues: write` on `RobinopdeBeek/jeeves`:

```bash
cd docs/plans/slice-8-github-issue-updates
./apply.sh
```

## What changed (summary)

- **ADR clarity:** link the AI Review / Prepare Eval ADR by **filename**
  (`0015-ai-review-reworks-eval-on-human-review-entry.md`). Note that PR #54 also added
  `0015-project-chat-threads-and-chatsession.md` (number collision — renumber chat ADRs
  separately).
- **Baseline:** Project Chat / app shell (#33) is **landed** via PR #54 — not an assumption.
- **Card attachments:** deferred (do not inject into Plan/Implement prompts in slice 8).
- **#61:** when adding `prepeval`, also extend step-key enums introduced by #54
  (e.g. `cardAttachments.originStep`).
- **#63:** DiffViewer package is **not** in deps after #54 — add it as part of this ticket.
