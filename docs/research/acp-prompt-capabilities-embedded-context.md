# ACP prompt capabilities: embedded file context vs images

**Verdict:** Cursor Agent CLI ACP still **advertises** `{ image: true, audio: false, embeddedContext: false }` on `initialize` (stable from forum dumps Mar–Apr 2026 through local `2026.07.20-8cc9c0b` and prior spike `2026.07.23-e383d2b`). ACP says clients **MUST** withhold `type: "resource"` when `embeddedContext` is false — and that is why Jeeves only offers images. **But a live runtime probe on this machine contradicts treating the flag as a hard Cursor reject:** with agent `2026.07.20-8cc9c0b` + `CURSOR_API_KEY`, a `session/prompt` containing a markdown `type: "resource"` block returned `stopReason: "end_turn"` (no RPC error), and the model replied `RESOURCE-OK` after being asked to confirm a secret token that existed only inside that embedded resource. So today the limitation in Jeeves is **capability-gated fail-closed client policy**, not a demonstrated inability of Cursor ACP to ingest embedded files.

**Date of research:** 2026-08-06

---

## Findings

### 1. ACP protocol: `type: "resource"` requires `embeddedContext`; images require `image`

**Claim:** Embedded file/blob attachments in `session/prompt` are `ContentBlock`s with `type: "resource"` and are capability-gated by `promptCapabilities.embeddedContext`. Images use `type: "image"` gated by `image`. Baseline (always required) is `text` + `resource_link` (URI reference, not embedded bytes).

**Source:** [Content](https://agentclientprotocol.com/protocol/content); [Initialization — Prompt capabilities](https://agentclientprotocol.com/protocol/initialization#prompt-capabilities); [Schema — `PromptCapabilities` / `PromptRequest`](https://agentclientprotocol.com/protocol/schema).

**Evidence:**

- Content docs: image / audio / embedded resource each say they **require** the matching prompt capability when included in prompts. Embedded Resource example:

```json
{
  "type": "resource",
  "resource": {
    "uri": "file:///home/user/script.py",
    "mimeType": "text/x-python",
    "text": "def hello():\n    print('Hello, world!')"
  }
}
```

  Narrative: preferred way to include @-mention-style context by embedding contents the agent may not otherwise access.

- Initialization: baseline — Agents **MUST** support `ContentBlock::Text` and `ContentBlock::ResourceLink`. Optional: `image` → `Image`; `audio` → `Audio`; `embeddedContext` → `Resource`.

- Schema `PromptCapabilities.embeddedContext`: “When enabled, the Client is allowed to include `ContentBlock::Resource` in prompt requests…” Default for the three flags: `false`.

- Schema on `PromptRequest.prompt`: Agent MUST support Text + ResourceLink; other variants optionally via `PromptCapabilities`. “The Client MUST adapt its interface according to `PromptCapabilities`.” When available, Resource is preferred over ResourceLink.

---

### 2. ACP protocol: clients MUST check capabilities before sending gated blocks

**Claim:** Capability negotiation puts the **obligation on the client**: do not send content types the agent did not advertise. The protocol does **not** state that agents MUST reject unsupported `resource` / `image` / `audio` blocks with a specific error.

**Source:** [Prompt Turn — User Message](https://agentclientprotocol.com/protocol/prompt-turn#1-user-message); [Initialization — Capabilities](https://agentclientprotocol.com/protocol/initialization#capabilities); schema language above.

**Evidence:**

- Prompt Turn: “Clients **MUST** restrict types of content according to the Prompt Capabilities established during initialization.”
- Initialization: capabilities omitted in `initialize` are **UNSUPPORTED**; new capabilities are non-breaking; peers SHOULD support all combinations of the other’s capabilities.
- Schema: “The Client MUST adapt its interface according to `PromptCapabilities`” / embeddedContext “Client is allowed to include…” when enabled.

**Reading for “does `false` mean reject?”:** Per protocol, `embeddedContext: false` means **clients must not send** `type: "resource"`. It does **not** document a mandatory agent-side rejection semantics. Separately, Cursor has advertised other ACP capabilities that were not actually implemented (e.g. forum reports on MCP / `loadSession`) — so **`true` is not always trustworthy either**, but **`false` is a clear “do not send” signal** for a compliant client.

---

### 3. Cursor official ACP docs: no promptCapabilities / resource / image attachment surface

**Claim:** Cursor’s `agent acp` documentation describes initialize → authenticate → session → prompt, modes, permissions, MCP, and Cursor extension methods, but does **not** document `promptCapabilities`, `embeddedContext`, or sending `image` / `resource` ContentBlocks. The published minimal client prompts with text only.

**Source:** [ACP (Cursor CLI)](https://cursor.com/docs/cli/acp).

**Evidence:** Minimal Node client:

```js
await send("session/prompt", {
  sessionId,
  prompt: [{ type: "text", text: "Say hello in one sentence." }],
});
```

`initialize` in that example sends `clientCapabilities` / `clientInfo` only — it does not discuss reading `agentCapabilities.promptCapabilities` from the result. Extension methods include `cursor/generate_image` (agent → client notification about a generated image), which is orthogonal to client→agent image/resource prompt attachments.

---

### 4. Live community `initialize` dumps: `embeddedContext: false`, `image: true` (stable across builds)

**Claim:** Public Cursor forum dumps of `agent acp` `initialize` results show the same promptCapabilities shape from at least March through mid-April 2026, including after other capability additions (`sessionCapabilities.list`).

**Source:** [ACP: support `session/list` method](https://forum.cursor.com/t/acp-support-session-list-method/156222) (community evidence; not product docs).

**Evidence (verbatim capability objects from user posts):**

| CLI version (forum) | `promptCapabilities` |
| --- | --- |
| `2026.03.25-933d5a6` | `{ "audio": false, "embeddedContext": false, "image": true }` |
| `2026.03.30-a5d3e17` | same |
| `2026.04.16-2d20146` | same (plus new `sessionCapabilities: { list: {} }`) |

Example result fragment (2026.04.16):

```json
"promptCapabilities": {
  "audio": false,
  "embeddedContext": false,
  "image": true
}
```

---

### 5. Local probes (this machine + prior Jeeves research): same flags through July 2026

**Claim:** Installed Cursor Agent CLI on this machine, and a prior in-repo spike, match the forum shape: images on, embedded context off.

**Source:** Live local probe (this research); [ACP model selection note](./acp-model-selection.md) Unknown #8; scripts under `.scratch/qa/probe-acp-caps.mjs` / `probe-resource-text.mjs`.

**Evidence:**

| Probe | Agent version | `promptCapabilities` |
| --- | --- | --- |
| This machine (initialize) | `2026.07.20-8cc9c0b` | `{ audio: false, embeddedContext: false, image: true }` |
| Prior Jeeves spike (`docs/research/acp-model-selection.md`) | `2026.07.23-e383d2b` | same: `image: true`, `audio: false`, `embeddedContext: false` |

No contradictory Cursor `initialize` dump with `embeddedContext: true` was found.

### 5b. Runtime probe: `type: "resource"` works despite `embeddedContext: false`

**Claim:** On this machine’s Cursor Agent `2026.07.20-8cc9c0b`, sending an out-of-capability embedded markdown `resource` block is **accepted and used by the model**.

**Source:** Live local probe 2026-08-06 (`.scratch/qa/probe-resource-text.mjs`), cwd `jeeves-test-pantry-checker`, auth via `CURSOR_API_KEY` (no interactive `authenticate`).

**Evidence:**

1. `initialize` → `promptCapabilities.embeddedContext === false`
2. `session/new` succeeded without `authenticate`
3. `session/prompt` with text + `{ type: "resource", resource: { uri: "attachment://probe.md", mimeType: "text/markdown", text: "...EMBEDDED-CONTEXT-PROBE-42..." } }` → `{ stopReason: "end_turn" }` (not Method/Invalid params)
4. Streamed assistant text: `RESOURCE-OK` (instruction was to reply that only if the secret token from the attached file was visible)
5. Follow-up text-only control turn replied `TEXT-OK`

**Reading:** Advertised `false` is **not** a reliable “Cursor cannot do this” signal for this build. It remains a protocol “client must not send” signal. Jeeves’ image-only picker is following the advertisement, not a runtime Cursor rejection.

---

### 6. No Cursor changelog/docs found enabling `embeddedContext`

**Claim:** Searches of Cursor product changelog / docs for ACP + `embeddedContext` / enabling embedded prompt resources did not surface a first-party announcement that Cursor ACP turned `embeddedContext` on.

**Source:** Cursor changelog pages mentioning ACP (e.g. [JetBrains ACP](https://cursor.com/changelog/03-04-26)); [ACP (Cursor CLI)](https://cursor.com/docs/cli/acp); web search over `site:cursor.com` for `embeddedContext` / ACP prompt capabilities.

**Evidence:** JetBrains ACP changelog announces IDE integration via ACP, not prompt ContentBlock capabilities. Official ACP page (claim 3) never mentions `embeddedContext`. No changelog hit stating the flag flipped to `true`.

---

### 7. Distinction: `resource_link` vs `resource` (files without embedding)

**Claim:** Clients can still reference files via baseline `type: "resource_link"` without `embeddedContext`. That is a URI/name pointer the agent “can access,” not an embedded payload. Prefer `resource` only when the capability is true.

**Source:** [Content — Resource Link / Embedded Resource](https://agentclientprotocol.com/protocol/content); schema `PromptRequest` preference note.

**Evidence:** Resource Link example (`uri`, `name`, optional `mimeType` / `size`) has **no** `embeddedContext` gate in the Content page. Embedded Resource explicitly requires `embeddedContext`. Schema: when Resource is available it is preferred (avoids round-trips / agent-inaccessible sources).

**Implication:** For Cursor today (`embeddedContext: false`), protocol-legal file *references* may still be `resource_link` (if the agent can read the path via tools/`cwd`); **inlined file bytes/text as `type: "resource"` are out of capability.** Images may be sent as `type: "image"` because `image: true`.

---

## Practical reading for Jeeves

1. **Advertisement vs runtime diverge today.** `embeddedContext: false` is still what Cursor reports; empirically markdown `resource` blocks work on `2026.07.20-8cc9c0b`. Jeeves’ former image-only UX was our fail-closed policy, not proof Cursor rejects files.
2. **Protocol-correct default:** keep gating images/audio on live `initialize` caps. That avoids depending on an undocumented under-advertised feature that could break on upgrade.
3. **Product override (shipped — ADR 0017):** Jeeves sends high-confidence text allowlist types as `resource.text` despite `embeddedContext: false`, and stores attachment bytes as sidecars. Re-probe on each agent version; do not broaden to PDF / octet-stream until probed. See [ADR 0017](../adr/0017-chat-attachment-sidecars.md).
4. **Images remain the officially advertised rich path** (`image: true`).
5. **Alternatives that stay protocol-legal without override:** paste into text; write file into cwd and use `resource_link` / agent tools; wait for Cursor to advertise `embeddedContext: true`.
6. **Re-probe on agent upgrade** — both the flag and the runtime acceptance can change independently.

---

## Unknown / not established

1. **PDF / binary blob `resource` blocks** — only a small markdown text resource was probed; do not assume PDF/docx parity.
2. **Whether `resource_link` works well** with Cursor ACP in practice — not probed here.
3. **Whether Cursor will ever flip `embeddedContext` to `true`** — no announcement; advertisement has been `false` for months while runtime acceptance exists.
4. **Stability across models / modes / future CLI builds** — probed once on one build + default model.
5. **Parity with `@cursor/sdk` attachments** — separate surface from ACP `ContentBlock`s.
