# Thin adapters over five deep modules

All behaviour lives in five deep modules — `PipelineEngine`, `CardStore`, `ArtifactStore`, `ExecutionEngine`, `AcpBridge` — and the HTTP routes and React client are thin adapters over their interfaces, containing no transition rules, derivation logic, or storage knowledge. The module interfaces are pre-agreed seams: every PRD sketches its testing against them and all TDD happens at them, which only works if the seams are fixed before the slices that build against them.

## Consequences

- A route or component that grows logic is a smell to push down, not a sixth module.
- Changing a seam signature is a cross-cutting decision (it invalidates the testing contract), not a local refactor.
