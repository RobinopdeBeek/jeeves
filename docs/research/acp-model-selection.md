# ACP model selection for Cursor clients

**Verdict:** The Agent Client Protocol defines a standard, session-scoped way to advertise and switch models (`configOptions` with `category: "model"`, changed via `session/set_config_option`). Cursor’s official `agent acp` docs do **not** document that wire path for model selection; they document modes, auth, prompts, and Cursor extension methods, and the published minimal client never sets a model. Separately, Cursor CLI global options include `--model` / `--list-models` / `agent models`, which can be combined with any command (including `acp`) at process launch. **Cursor staff (2026-07-13) stated that runtime model switching via third-party ACP client pickers is not supported today; pinning with `--model` at ACP launch is the reliable workaround.** By contrast, `@cursor/sdk` documents first-class `model: { id, params? }` on create/prompt and sticky per-run overrides on `agent.send()`. Prompt attachments in ACP are `ContentBlock`s on `session/prompt` (text/image/resource/…); they are not how you pick a model.

**Date of research:** 2026-08-01

---

## Findings

### 1. ACP protocol: model selection is a session config option (not a prompt field)

**Claim:** Agents may expose a model selector as a `configOptions` entry (typically `category: "model"`, `type: "select"`) on session setup responses; clients change it with `session/set_config_option`.

**Source:** [Session Config Options](https://agentclientprotocol.com/protocol/session-config-options) (ACP v1 docs).

**Evidence (paraphrase + structure):** The page states agents can provide configuration options “for things like models, modes, reasoning levels, and more,” and shows an example `session/new` **result** containing:

```json
{
  "id": "model",
  "name": "Model",
  "category": "model",
  "type": "select",
  "currentValue": "model-1",
  "options": [
    { "value": "model-1", "name": "Model 1" },
    { "value": "model-2", "name": "Model 2" }
  ]
}
```

Clients set a value with:

```json
{
  "method": "session/set_config_option",
  "params": {
    "sessionId": "sess_abc123def456",
    "configId": "mode",
    "value": "code"
  }
}
```

(The same method applies to a model option by using that option’s `id` as `configId` and a listed `options[].value` as `value`.) The agent must return the **complete** updated `configOptions` list. Agents may also push updates via `session/update` with `sessionUpdate: "config_option_update"`.

**Reserved categories** (UX metadata only): `mode`, `model`, `model_config`, `thought_level`.

**Timing:** “The current value of a config option can be changed at any point during a session, whether the Agent is idle or generating a response.”

---

### 2. ACP protocol: `session/new` request does not take a model id

**Claim:** Creating a session requires `cwd` and `mcpServers` (plus optional roots); model is not a request parameter.

**Source:** [Session Setup](https://agentclientprotocol.com/protocol/session-setup); [Schema — `NewSessionRequest`](https://agentclientprotocol.com/protocol/schema).

**Evidence:** Session Setup documents `session/new` params as working directory + MCP servers. The schema’s `NewSessionRequest` properties are `_meta`, `additionalDirectories`, `cwd` (required), `mcpServers` (required). `NewSessionResponse` **may** include `configOptions` / `modes` / required `sessionId`. Session Setup also notes that `session/resume` responses “MAY also include initial mode, model, or session configuration state when those features are supported by the Agent.”

---

### 3. ACP protocol: `session/prompt` has no model parameter; attachments are ContentBlocks

**Claim:** A prompt turn sends `sessionId` + `prompt: ContentBlock[]` only. Model is not selected per prompt via this method. File/image context rides in content blocks.

**Source:** [Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn); [Content](https://agentclientprotocol.com/protocol/content); [Schema — `PromptRequest`](https://agentclientprotocol.com/protocol/schema).

**Evidence:** Prompt Turn’s example `session/prompt` params are `sessionId` and a `prompt` array mixing `type: "text"` and `type: "resource"` (embedded file). Schema `PromptRequest` properties: `_meta`, `prompt` (required `ContentBlock[]`), `sessionId` (required). No `model` field.

Content block types documented: `text`, `image` (capability-gated), `audio` (capability-gated), `resource` / embedded context (capability-gated `embeddedContext`), `resource_link`. These are “displayable information” for prompts/updates/tool results — orthogonal to session config options for model selection.

---

### 4. ACP v2 migration: model selection stays on config options; dedicated modes API goes away

**Claim:** v2 removes `session/set_mode` in favor of `session/set_config_option`; model/thought knobs remain config options.

**Source:** [v2 Migration](https://agentclientprotocol.com/protocol/v2/migration).

**Evidence:** Migration table: `session/set_mode` → **Removed**. Use `session/set_config_option`. Narrative: “Mode-like state (and model selection, thinking level, and similar knobs) is expressed through session config options.” Stable categories remain `mode`, `model`, `model_config`, `thought_level`. v2 `session/set_config_option` uses an explicit value `type` discriminator (`id` / `boolean` / extension) — see [v2 Session Config Options](https://agentclientprotocol.com/protocol/v2/session-config-options).

---

### 5. Cursor `agent acp` docs: document the ACP session flow, not model-switch APIs

**Claim:** Official Cursor ACP docs describe starting `agent acp`, auth, `session/new` / `session/prompt`, permissions, MCP, and Cursor extension methods — but do not document `configOptions`, `session/set_config_option`, or a model id list over ACP.

**Source:** [ACP (Cursor CLI)](https://cursor.com/docs/cli/acp).

**Evidence:**

- Start: `agent acp`; transport stdio + JSON-RPC newline framing.
- Request flow: `initialize` → `authenticate` (`cursor_login`) → `session/new` (or `session/load`) → `session/prompt` → handle `session/update` / `session/request_permission` → optional `session/cancel`.
- Modes listed for ACP sessions: `agent`, `plan`, `ask` (same core modes as CLI) — without documenting the JSON-RPC method/params used to set them.
- Minimal Node client calls `session/new` with `{ cwd, mcpServers: [] }` and `session/prompt` with `prompt: [{ type: "text", text: "..." }]` only — no model.
- Cursor extension methods documented: `cursor/ask_question`, `cursor/create_plan`, `cursor/update_todos`, `cursor/task`, `cursor/generate_image`. Of these, `cursor/task` includes an optional `model?: string` field on the **notification/request shape for subagent tasks**, not a documented chat-session model picker API.

---

### 6. Cursor CLI parameters: `--model` / model listing are global CLI affordances

**Claim:** Cursor Agent CLI documents `--model`, `--list-models`, and `agent models` as ways to choose/list models at the CLI layer; global options “can be used with any command,” and `acp` is a command.

**Source:** [Parameters](https://cursor.com/docs/cli/reference/parameters).

**Evidence (quotes/paraphrase):**

- “Global options can be used with any command.”
- `--model <model>` — “Model to use”
- `--list-models` — “List all available models”
- Command `models` — “List available models for this account” (`agent models`)
- Command `acp` — “Start ACP server mode (advanced, hidden command)” (`agent acp`)

**Implication from docs alone:** `agent --model <id> acp` is consistent with the published “global options × any command” rule. The ACP page itself does not show this example or state that the flag pins the ACP session model for the process lifetime.

---

### 7. Cursor JetBrains ACP integration: product claim of model switching, no wire API

**Claim:** JetBrains integration docs say users can choose/switch frontier models when using Cursor via ACP in JetBrains IDEs, without specifying `session/set_config_option` or model ids.

**Source:** [JetBrains](https://cursor.com/docs/integrations/jetbrains).

**Evidence:** Under “What you get”: “**Model selection** — Choose from frontier models… switch between them as needed.” Architecture note: JetBrains is the ACP client; Cursor’s agent is the server. No JSON-RPC field names for model.

---

### 8. `@cursor/sdk`: explicit `model: { id }` (and optional `params`) at agent and run scope

**Claim:** The TypeScript SDK documents first-class model selection distinct from ACP config options.

**Source:** [TypeScript SDK](https://cursor.com/docs/sdk/typescript).

**Evidence:**

**Selection shape:**

```typescript
interface ModelSelection {
  id: string;
  params?: ModelParameterValue[];
}
```

**Create / one-shot:**

```typescript
const agent = await Agent.create({
  apiKey: process.env.CURSOR_API_KEY!,
  model: { id: "composer-2.5" },
  local: { cwd: process.cwd() },
});
```

`AgentOptions.model` is “Required for local; cloud falls back to the server-resolved default.”

**Discover ids:**

```typescript
function Cursor.models.list(options?: CursorRequestOptions): Promise<SDKModel[]>;
```

Use before `Agent.create` / `agent.send`. Catalog includes parameter definitions and preset `variants`.

**Per-run (sticky) override:**

```typescript
const run = await agent.send("Plan the refactor", {
  model: { id: "composer-2.5", params: [{ id: "fast", value: "true" }] },
});
```

Docs: override applies to that run then becomes sticky on `agent.model` after success. `run.model` / `result.model` reflect the run’s immutable selection.

**Attachments near the send API (not model):** images are passed on `agent.send` as `{ text, images: [{ data, mimeType }] }`, separate from `ModelSelection`.

**First-party GitHub (Cursor):** [cursor/plugins cursor-sdk skill](https://github.com/cursor/plugins/blob/HEAD/cursor-sdk/skills/cursor-sdk/SKILL.md) restates the same pattern (`model: { id: "…" }`, `Cursor.models.list`, model required for local / optional for cloud). [cursor/cookbook coding-agent-cli](https://github.com/cursor/cookbook/blob/main/sdk/coding-agent-cli/src/agent.ts) uses `ModelSelection` with `Agent.create({ model, local|cloud })`.

---

## Comparison table: ACP vs Cursor SDK (model selection)

| Concern | ACP (protocol) | Cursor `agent acp` (Cursor docs) | `@cursor/sdk` (documented) |
| --- | --- | --- | --- |
| Where model is chosen | Session config: `configOptions` + `session/set_config_option` | Not documented on the ACP JSON-RPC surface; CLI has global `--model` / `agent models` | `Agent.create` / `Agent.prompt` / `agent.send` `model: ModelSelection` |
| List available models | Agent advertises `options[]` on a `category: "model"` config option (if implemented) | CLI: `--list-models` / `agent models` (not documented as an ACP RPC) | `Cursor.models.list()` → `SDKModel[]` with `id`, `parameters`, `variants` |
| Per-session switch | Yes (protocol): `session/set_config_option` anytime | Unknown / not documented for Cursor’s agent | Sticky per-run override via `send({ model })`; also set at create |
| Per-turn / per-prompt model field | No on `session/prompt` | Minimal client has none | Yes: `agent.send(prompt, { model })` |
| Model params (fast, thought, router, …) | Via sibling config categories e.g. `model_config`, `thought_level` (if agent exposes them) | Not documented for ACP | `model.params: [{ id, value }]` discovered from catalog |
| Create-time model arg | Not on `session/new` request | N/A (process/CLI level only if using globals) | Required for local: `model: { id }` |
| Attachments / files | `ContentBlock` on `session/prompt` (`text` / `image` / `resource` / …) | Minimal example uses text only; `cursor/generate_image` is a Cursor extension for generated images | `send({ text, images: [...] })` |

---

### 9. Cursor staff (forum): runtime ACP picker unsupported; `--model` is the workaround

**Claim:** As of 2026-07-13, Cursor staff say runtime model switching through third-party ACP client pickers is not supported; launching with `--model` pins the session.

**Source:** Cursor forum staff replies in [ACP model selection API removed?](https://forum.cursor.com/t/acp-model-selection-api-removed/160063) (not product docs; first-party staff statements).

**Evidence (paraphrase):**

- Users reported empty `configOptions[model].options` / empty `models.availableModels` from `session/new` across several May–June 2026 CLI builds; invalid `--model` values were rejected (`Cannot use this model`), suggesting the startup flag is validated even when ACP metadata stays empty.
- Staff (mohitjain, 2026-07-13): runtime switching via third-party ACP client pickers “isn’t something we support today”; dependable approach is `cursor-agent --model … acp`, listing ids with `--list-models` / `agent models`; no timeline for native runtime switching.
- One user later reported the picker working again in IntelliJ/Zed on CLI `2026.07.09-a3815c0`; treat that as anecdotal against the staff “not supported” stance until product docs catch up.

---

### 10. Jeeves today

**Claim:** Jeeves’ ACP spawn does not pass `--model`.

**Source:** `server/ws/acp-process.ts` — `spawn(…, [...launch.args, "acp"], …)`.

---

## Unknown / not documented

These items were **not** established from official Cursor product docs / ACP specs / SDK docs alone:

1. **Whether a given installed `agent` build advertises non-empty model `configOptions`** on `session/new` (forum reports conflict by version).
2. **Whether `session/set_config_option` for model succeeds on Cursor’s agent today** — staff say runtime picker switching is unsupported; probe locally before depending on it.
3. **Whether CLI `--model` before `acp` is guaranteed across `session/load` vs only fresh `session/new`.**
4. **Exact model id vocabulary parity** across `agent models` / `--model`, ACP `configOptions[].options[].value` (if any), and SDK `ModelSelection.id` / `Cursor.models.list()`.
5. **How JetBrains (or Zed/Neovim) ACP clients implement the “Model selection” UX** against Cursor — JetBrains docs claim the capability without documenting the RPC.
6. **Cursor-private ACP client capabilities / `_meta` extensions** for parameterized model pickers (variants, Max, thought level).
7. **Per-prompt model override for Cursor ACP** — not in ACP `PromptRequest`; Cursor docs do not add a Cursor-specific extension for it.
8. **Whether Cursor ACP prompt capabilities include `image` / `embeddedContext`** in practice — **resolved for the installed Cursor CLI (2026.07.23-e383d2b):** `image: true`, `audio: false`, `embeddedContext: false`. Jeeves still fail-closes from the live `initialize` probe rather than hard-coding this spike.
9. **Exact machine-readable shape** of `agent models` / `--list-models` output (needs a local CLI probe).

---

## Practical reading for an ACP client author

1. **Protocol-correct path for runtime model UX:** after `session/new`, if `configOptions` contains a model select, call `session/set_config_option` with that option’s `id` and a listed value; keep UI in sync with the full returned `configOptions` and any `config_option_update` notifications.
2. **Cursor-documented + staff-endorsed path today:** implement the [ACP client flow](https://cursor.com/docs/cli/acp); pin model at process start with CLI `--model`; list via `agent models` / `--list-models`. Do not assume mid-session picker RPC works.
3. **If you need SDK-grade model control** (`model: { id }`, catalog discovery, per-run sticky overrides, `params`): use [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript), not ACP alone.
4. **Attachments:** use ACP `ContentBlock`s on `session/prompt` for files/images; do not conflate them with model selection APIs.

## Implications for Jeeves Project Chat

1. **Real picker control:** persist preferred model per Chat Thread; (re)spawn that thread’s ACP with `--model <id>`; populate options from `agent models` / `--list-models`.
2. **Model change = process replace** for that warm slot (acceptable with one process per Chat Thread) until Cursor supports stable runtime `configOptions`.
3. Do not promise seamless mid-turn switching in v1.
