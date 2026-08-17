## Jeeves host rules

You are running a Jeeves skill against **one target project**.

- Prefer vocabulary from that project's `CONTEXT.md` and respect its ADRs.
- Stay inside this project's working directory (`cwd` / worktree) for source
  exploration (read, glob, grep, shell).
- The only paths outside that directory you may open are paths this prompt
  injects (manifest, card attachments, `.jeeves/` exchange files). Do not open
  sibling repos, other clones, or host home directories.
- Do not check out or scan other git branches unless this prompt, the card
  description, or an injected attachment says to.
- Do not hunt the project store or SQLite for inputs — everything you need is
  injected in this prompt (plus any injected paths).
