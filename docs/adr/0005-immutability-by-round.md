# Immutability by round

Re-running a step creates a new `(card, step, round)` artifact version, never an overwrite, and record tables (`artifacts`, `runs`, `change_requests`, `decisions`, `notifications`) are append-only and round-scoped. This is the storage-level formalisation of the rework loop: a changes-requested decision at round N begets round N+1, prior rounds' evaluations persist read-only, and a feature's Round N task history stays traceable after rework — none of which survives if rows are mutated in place.

## Consequences

- Change requests are never deleted on consumption; they flip `open` → `consumed` and remain visible as "changes added later".
- The artifact folder mirrors the rule: one subfolder per round and an immutable unique destination per successful version (for example `plan/<artifactId>.md`). Known exchange file paths such as `.jeeves/plan.md` are only staging locations; harvest never overwrites a prior canonical artifact, even within the same round.
- **Exception — in-round mutable drafts:** transcripts and Spec markdown (`kind: transcript`, `kind: spec`) are intentionally overwritten in place while their step is still `needs-user`. They share one canonical path per `(card, step, round)` (e.g. `spec/spec.md`). Human edits, `/to-spec` harvest, and Spec-assist harvest all upsert that path; freeze on step hand-off (Spec → Tasks closes Spec mutability). Append-only harvest still applies to execution artifacts (plan, patch, eval, …).
- **Exception — Tasks tip versions:** `kind: tasks-draft` is also in-round shaping state, but **append-only** within `(card, round)` — every Save / Delete / undo / AI harvest writes a new JSON artifact; `latest` by `created_at` is the tip ([ADR 0014](./0014-tasks-drafts-are-versioned-artifacts.md)). Do not upsert tasks-draft like Spec.
- Only the designated current-state tables (`cards`, `card_steps`) may be mutated in place (see ADR 0002).
