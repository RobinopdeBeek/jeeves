# AI SDK + assistant-ui for chat; AgentRunner for execution

All AI inference runs on the Cursor subscription — via the ACP bridge for interactive chat and via `@cursor/sdk` local for autonomous execution. We adopt **Vercel AI SDK 5** (`ai`, `@ai-sdk/react`) as the chat primitive: `useChat` owns message state, streaming, and typed `UIMessage` parts. **assistant-ui** (`@assistant-ui/react`, `@assistant-ui/react-ai-sdk`) sits on top for pre-built chat UI primitives (message list, composer, streaming indicators) rather than hand-rolling them. assistant-ui is a headless component layer over AI SDK, not a replacement for it.

The real chat engineering lives in **`AcpBridge`**: it projects ACP JSON-RPC session events into AI SDK `UIMessage` parts server-side and streams them to the client over WebSocket via a custom `ChatTransport`. ACP vocabulary must not leak past this seam — the client only ever sees AI SDK stream types. This includes **permission requests**: ACP sessions can ask the user to approve actions mid-stream; these become custom message parts with a response path wired back through the transport. Chat transcripts persist as serialized `UIMessage[]` artifacts (grill summary hand-off, replay).

For autonomous runs, **`ExecutionEngine`** exposes `enqueue(card, step)` + a run-event stream and hides an inner **`AgentRunner`** interface (`run(prompt, options): AsyncIterable<RunEvent>`). Each call gets a fresh worktree on the card's durable branch. The options include a generic asynchronous finalization callback that receives the temporary workspace path and Git result after the agent exits but before cleanup; `ExecutionEngine` uses that window to harvest through `ArtifactStore` and enforce step-specific postconditions. A finalization failure fails the run and preserves diagnostics. Today's implementation is **`@cursor/sdk` local** (`Agent.create` with `cwd` set to the run worktree, `composer-2.5`). See [ADR 0010](./0010-self-managed-worktrees-cursor-sdk.md) for worktree lifecycle and sandbox policy. We do not couple `runner.ts` directly to the SDK's API — this keeps the door open to swap in Vercel AI SDK's experimental `HarnessAgent` later (for Cursor if/when supported, or Claude Code/Codex as alternatives) without touching the board, queue, or chat UI. Harness streams project into AI SDK stream types (`toUIMessageStream` + `useChat`), so adopting a harness adapter later changes only what's behind `AgentRunner`.

**Structured skill outputs** (e.g. `/to-issues` emitting `{ title, description, depends_on }[]`) use **Zod-validated sidecar files**: the skill writes JSON to a known worktree path, the runner harvests it, validates with a Zod schema on the host, and retries with error feedback on parse failure. We do **not** use AI SDK `generateObject`/`generateText` for these — that would introduce a second billing path (provider API keys) and bypass Cursor's codebase context, which `/to-issues` specifically needs.

**Explicitly not using (for now):**

- **CopilotKit / AG-UI** — a full agentic app framework (shared state, generative UI, frontend tool calls) built for a different problem; we need a chat window bridging to Cursor, not agents rendering dynamic UI.
- **LangChain / Mastra / CrewAI** — backend orchestration for building agent reasoning loops ourselves; Cursor's ACP session and SDK local runs already are the agent.
- **AI Elements** — redundant with assistant-ui.
- **Vercel Sandbox / Workflows / AI Gateway** — hosted infra we don't need while running locally on Cursor's subscription.
- **HarnessAgent as the primary execution path** — Cursor isn't a supported adapter yet and the API is explicitly experimental/unstable. Revisit if/when Cursor lands as a first-class harness adapter.

## Consequences

- Chat step components (`StepGrill`, PRD side-chat) are thin adapters over `useChat` + assistant-ui; the ACP→UIMessage projection is owned entirely by `AcpBridge`.
- Permission-request UI is a custom assistant-ui message part, not something either library provides out of the box.
- `ExecutionEngine` tests mock `AgentRunner`; SDK integration tests live behind the implementation (real SDK = manual / `npm run spike:sdk`).
- Plan and review runs succeed only when their declared artifacts are harvested and the source tree is unchanged; Implement succeeds only with required commits and a clean tree.
- Retries capture the failed tree's status/diff, discard that generated worktree, and recreate from the recorded pre-run SHA.
- `/to-issues` and similar structured-output skills document their sidecar path and Zod schema alongside the prompt; parse failures surface as run errors with retry, not silent bad data.
- Adding a provider API key for direct `generateObject` calls is a deliberate ADR-level decision, not an implementation detail.
- Sandcastle + Docker agent execution is superseded by [ADR 0010](./0010-self-managed-worktrees-cursor-sdk.md).
