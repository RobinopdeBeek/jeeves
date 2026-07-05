---
name: architecture-doc
description: Create or refresh a project's ARCHITECTURE.md, the structural source of truth. Use when the user wants an architecture overview written down, says the architecture doc is stale or missing, or when another skill needs the module map or system context recorded.
---

# Architecture Doc

`ARCHITECTURE.md` at the repo root is the structural source of truth: how the system is shaped, what it runs on, and where the seams are. A starting point for humans, a reference for AI. It completes a document triangle — vocabulary lives in `CONTEXT.md`, decision reasoning in `docs/adr/`, structure here. Static and foundational aspects only: nothing that expires with a plan or sprint.

Section-by-section format lives in [SECTIONS.md](./SECTIONS.md).

## Own vs point

The failure mode of architecture docs is silent rot, and rot comes from copies. So every paragraph must pass the litmus test: **would an agent that read the whole codebase still get this wrong?** If only a human's head says it — the shape, the boundaries, the non-goals — write it. If some file already says it, point at that file instead: the schema owns columns, ADRs own reasoning, `CONTEXT.md` owns definitions, the code owns step mechanics. Pointers over copies, always.

Deliberately excluded, whatever the project: build orders and slice sequences (plans expire), prompt or task inventories (self-describing where they live), open questions (plan material).

## Creating from scratch

1. Gather the sources: plan or design documents, `CONTEXT.md`, `docs/adr/`, and the code itself (manifest files, entry points, schema, module folders). Done when you can name the system's processes, modules, entities, and stack without guessing.
2. Draft each section per [SECTIONS.md](./SECTIONS.md), applying the litmus test to every paragraph.
3. Verify every concrete claim — paths, module names, stack choices — against the codebase. For a pre-code project, claims come from the plan; note in the doc that file paths are planned, not built. Done when every claim is verified or explicitly forward-looking.

## Updating a stale one

1. Walk the existing file section by section against each section's source of truth: module map against actual folders and exports, data model against the schema, flows against the pipeline/routing code, stack against the dependency manifest, links against the files they target.
2. Fix what reality contradicts, and prune what now fails the litmus test — a section that has accumulated copies of code facts collapses back to a pointer. New architecture that the doc predates gets added through the same section format.
3. Done when every section has been checked against its source and the file contains no claim the codebase contradicts.
