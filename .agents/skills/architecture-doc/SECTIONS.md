# ARCHITECTURE.md — section format

The sections in order. Each states what it owns and what it points at; the own-vs-point
litmus tests from [SKILL.md](./SKILL.md) govern every paragraph. Keep each section short:
agents inflate this file by restating code and ADRs — resist that.

## Header

- A one-line statement of what the file is (the structural source of truth).
- A pointer block establishing the document triangle: vocabulary → `CONTEXT.md`, decisions
  → `docs/adr/`, columns/schemas → the schema file ("code is the source of truth for
  columns").
- One paragraph saying what the system *is* and its key insight — written for someone who
  has never seen the project.

## Overall architecture

One short paragraph giving the conceptual shape: the core structural choices an agent needs
before touching any module (e.g. "one process, deep modules, thin adapters", where state
lives, what is code vs data). End by pointing at `docs/adr/` for the reasoning — never
restate an ADR's argument.

### System context (runtime view)

The physical view, as a subsection: a diagram of the processes and stores — who spawns
whom, what is long-lived — followed by bullets on **what crosses each boundary** (protocols,
files, events). Stay at process/store altitude: name top-level stores, not every
subdirectory under them. Include the deployment/migration story in one line if it is
genuinely static.

Do **not** add extra topical sections that restate one layer's internals (chat transport,
execution pipeline, auth flow, etc.). One sentence plus an ADR pointer in Overall
architecture or Tech stack is enough; mechanics live in code and ADRs.

## Tech stack

A table of concern / choice / one-line *why* for **architectural** dependencies only
(runtime, persistence, primary backends, networking). Skip UI chrome libraries (icon sets,
editors, DnD kits) unless they define a hard architectural boundary. The why is the point —
a bare list restates the dependency manifest.

### Non-goals

Bullets of what is deliberately not built and won't be until a stated need arises. Negative
space is high-value: it stops agents and humans from helpfully adding it.

## Module map

The heart of the file. A table: module / where it lives / seam / what it hides. Name the
primary seam operations — they are the pre-agreed testing contracts — but never full method
inventories, option lists, or per-feature behaviors. Point at ADRs for rules that live
inside a module. Folder roots are enough for "lives in"; do not list every source file.

## Data model

Bullets describing the main entities and how they relate: ownership and parent links,
lifecycle states, which records are mutable current-state vs immutable/historical. Point at
the glossary for entity definitions and at the schema file for columns — never list columns,
never inventory on-disk paths beyond the top-level store pattern.

## Primary user flows

Two or three flows maximum (the happy path, the main loop, one variant), each as short
numbered steps at phase level — not click level or low-level step mechanics, which belong
to the code they would drift from. Point at where those mechanics live.
