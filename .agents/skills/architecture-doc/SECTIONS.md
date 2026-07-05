# ARCHITECTURE.md — section format

The sections in order. Each states what it owns and what it points at; the own-vs-point
litmus test from [SKILL.md](./SKILL.md) governs every paragraph.

## Header

- A one-line statement of what the file is (the structural source of truth).
- A pointer block establishing the document triangle: vocabulary → `CONTEXT.md`, decisions
  → `docs/adr/`, columns/schemas → the schema file ("code is the source of truth for
  columns").
- One paragraph saying what the system *is* and its key insight — written for someone who
  has never seen the project.

## Overall architecture

One short paragraph giving the conceptual shape: the core structural choices an agent needs
before touching any module (e.g. "one process, N deep modules, thin adapters", where state
lives, what is code vs data). End by pointing at `docs/adr/` for the reasoning — never
restate an ADR's argument.

### System context (runtime view)

The physical view, as a subsection: a diagram of the processes and stores — who spawns
whom, what is long-lived — followed by bullets on **what crosses each boundary** (protocols,
files, events). This is the highest-value orientation content because no single module
reveals it. Include the deployment/migration story in one line if it is genuinely static.

## Tech stack

A table of concern / choice / one-line *why*. The why is the point — a bare list restates
the dependency manifest.

### Non-goals

Bullets of what is deliberately not built and won't be until a stated need arises. Negative
space is high-value: it stops agents and humans from helpfully adding it.

## Module map

The heart of the file. A table: module / where it lives / interface (the seam) / what it
hides. Include the seam signatures (`advance(card)`, `enqueue(item)`) — they are the
pre-agreed contract that testing happens against — but never full interface listings; the
"where it lives" column covers the rest.

## Data model

Bullets describing the main entities and how they relate: ownership and parent links,
lifecycle states, which tables are mutable current-state vs immutable records. Point at the
glossary for entity definitions and at the schema file for columns — never list columns.

## Primary user flows

Two or three flows maximum (the happy path, the main loop, one variant), each as short
numbered steps at phase level — not click level, which belongs to the code it would drift
from. Point at where the step mechanics live.
