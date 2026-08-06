---
name: architecture-doc
description: Create or structurally update ARCHITECTURE.md. Use when the user asks for an architecture overview, the file is missing, or a real structural change landed (new process, deep module, store boundary, seam, or stack choice). Do not use for routine feature work, method/path inventories, or keeping the doc "in sync" with implementation detail — prefer CONTEXT.md or an ADR. Also use when another skill must record module map or system context after a structural change.
---

# Architecture Doc

`ARCHITECTURE.md` at the repo root is the structural source of truth: how the system is shaped, what it runs on, and where the seams are. A starting point for humans, a reference for AI. It completes a document triangle — vocabulary lives in `CONTEXT.md`, decision reasoning in `docs/adr/`, structure here. Static and foundational aspects only: nothing that expires with a plan or sprint.

**Altitude rule:** this file should rarely change. Update it only when structure changes — a new process or store boundary, a new deep module, a changed seam, a stack choice, or a non-goal. Do **not** update it for feature mechanics, method inventories, subdirectory layouts, or UI chrome. Those belong in code, ADRs, or `CONTEXT.md`.

Section-by-section format lives in [SECTIONS.md](./SECTIONS.md).

## Own vs point

The failure mode of architecture docs is silent rot, and rot comes from copies. So every paragraph must pass the litmus test: **would an agent that read the whole codebase still get this wrong?** If only a human's head says it — the shape, the boundaries, the non-goals — write it. If some file already says it, point at that file instead: the schema owns columns, ADRs own reasoning, `CONTEXT.md` owns definitions, the code owns step mechanics. Pointers over copies, always.

Second litmus: **would a later feature PR need to edit this sentence?** If yes, the sentence is too low-level — collapse it to a pointer or delete it.

Deliberately excluded, whatever the project: build orders and slice sequences (plans expire), prompt or task inventories (self-describing where they live), open questions (plan material), per-method API surfaces, on-disk subdirectory inventories, transport framing details, UI library minutiae.

## Creating from scratch

1. Gather the sources: plan or design documents, `CONTEXT.md`, `docs/adr/`, and the code itself (manifest files, entry points, schema, module folders). Done when you can name the system's processes, modules, entities, and stack without guessing.
2. Draft each section per [SECTIONS.md](./SECTIONS.md), applying both litmus tests to every paragraph. Prefer the shortest accurate statement.
3. Verify every concrete claim — module names, stack choices, process boundaries — against the codebase. For a pre-code project, claims come from the plan; note in the doc that file paths are planned, not built. Done when every claim is verified or explicitly forward-looking.

## Updating a stale one

1. First ask: did structure actually change? If the PR only added methods, paths, or feature behavior inside an existing module, **do not touch `ARCHITECTURE.md`** — fix vocabulary in `CONTEXT.md` or record reasoning in an ADR instead.
2. When structure did change: walk the existing file section by section against each section's source of truth: module map against actual deep-module folders, data model against entity relationships (not columns), flows against the system's phase/pipeline code, stack against architectural dependencies, links against the files they target.
3. Fix what reality contradicts, and prune what now fails either litmus test — a section that has accumulated copies of code facts collapses back to a pointer. Prefer deleting detail over adding it.
4. Done when every section has been checked against its source, the file contains no claim the codebase contradicts, and no sentence exists that a routine feature PR would need to rewrite.
