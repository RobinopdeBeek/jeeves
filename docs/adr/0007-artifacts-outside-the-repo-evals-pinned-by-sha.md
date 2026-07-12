# Artifacts live outside the repo; evaluations are pinned by git SHA

Jeeves' artifact folder (`data/cards/<cardId>/<round>/`) lives with the jeeves app, never inside the repository under review — the target repo stays git-clean, with no `.gitignore` juggling and no generated files in its history. The cost is that an evaluation is not committed alongside the diff it reviewed, so every evaluation records the reviewed commit's `git_sha` on its artifact row and in self-describing HTML metadata; that SHA is the only link back to the exact diff, and an evaluation without one is an orphan.

## Considered Options

Committing evaluations to the reviewed branch was rejected: it pollutes the target repo's history with generated HTML and couples jeeves' storage to every project it works on.

## Consequences

- `git_sha` is mandatory on evaluation artifacts, optional elsewhere.
- Workspace-produced non-evaluation artifacts record the producing HEAD SHA when known; host-only chat/spec artifacts may leave it null.
- Manual preview testing checks out the evaluation's exact `git_sha`, never the mutable branch tip.
- Sandbox-produced artifacts must be harvested out of the worktree before teardown, since the worktree is not their home.
