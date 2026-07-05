# Immutability by round

Re-running a step creates a new `(card, step, round)` artifact version, never an overwrite, and record tables (`artifacts`, `runs`, `change_requests`, `decisions`, `notifications`) are append-only and round-scoped. This is the storage-level formalisation of the rework loop: a changes-requested decision at round N begets round N+1, prior rounds' evaluations persist read-only, and a feature's Round N task history stays traceable after rework — none of which survives if rows are mutated in place.

## Consequences

- Change requests are never deleted on consumption; they flip `open` → `consumed` and remain visible as "changes added later".
- The artifact folder mirrors the rule: one subfolder per round, files never overwritten across rounds.
- Only the designated current-state tables (`cards`, `card_steps`) may be mutated in place (see ADR 0002).
