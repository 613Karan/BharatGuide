# Testing Cline SDK tool calling

An isolated harness for exercising the **Cline SDK** (`@cline/sdk`, v0.0.92) tool-calling
loop without touching the Ghost Cursor Electron build.

## Why this folder exists (read this first)

Three hard constraints were verified on this machine. Together they mean the SDK must run
in its **own ESM process under Node >= 22**, not inside the Electron main process:

| Constraint | Evidence |
| --- | --- |
| Electron 33.4.11 bundles **Node 20.18.3** | `electron.exe -e "process.versions.node"` -> `20.18.3`. The SDK declares `engines.node >= 22`. |
| `@cline/sdk` is **ESM-only, no `require` condition** | `require('@cline/sdk')` -> `ERR_PACKAGE_PATH_NOT_EXPORTED`. Its `exports` map is `{ types, import }` only. |
| `tsconfig.json` here is `"module": "CommonJS"` | TypeScript downlevels `await import(...)` to `Promise.resolve().then(() => require('@cline/sdk'))`, which hits the same error. |
| System Node is 24.20.0 | Meets `>= 22`, and runs `.ts` test files directly via built-in type stripping. |

So the test process is a **separate Node 24 ESM program**. Your Electron app (CJS, Node 20)
would have to talk to it over IPC/subprocess. That is an architecture decision, not a test
detail, which is why it is documented here rather than buried in a spec.

## The five layers

Test tool calling at four levels. They fail for different reasons, so keep them separate.

| Layer | File | Needs a model? | Answers |
| --- | --- | --- | --- |
| 1. Tool isolation | `tools.test.ts` | no | Does `execute()` do the right thing? Is the schema correct? |
| 2. Cline wiring | `cline-config.test.ts` | no (stub server) | Do `baseUrl` / `apiKey` / `modelId` produce the documented Cline endpoint? |
| 3. Agent loop, offline | `fake-provider.test.ts` | no (stub server) | Does the SDK advertise -> parse -> execute -> feed back a tool call? |
| 4. Real model | `agent.live.test.ts` | yes (skipped by default) | Does the **model** pick the right tool with valid arguments? |
| 5. Discovery | `dump-events.ts` | yes | What event `type` strings does *this* SDK version emit? |

The important split is **1 + 2 + 3 (deterministic, every commit)** vs **4 (non-deterministic,
opt-in)**. A failing live test is ambiguous - model, or SDK, or your description? The offline
layers remove that ambiguity, so when layer 4 fails you already know the plumbing and the Cline
wiring are fine and it is a prompt/description problem.

## Using Cline only

The SDK ships Cline as a first-class provider (verified in `@cline/llms/dist/providers.js`):

| providerId | Name | Default baseUrl | Key env |
| --- | --- | --- | --- |
| `cline` | Cline (usage-billing) | `https://api.cline.bot/api/v1` | `CLINE_API_KEY` |
| `cline-pass` | ClinePass | `https://api.cline.bot/api/v1` | `CLINE_API_KEY` |
| `openai-compatible` | any OpenAI endpoint | you supply it | you supply it |

The Cline API is OpenAI-compatible with **tool calling supported**, so either the native
`cline` id or `openai-compatible` + `baseUrl: "https://api.cline.bot/api/v1"` works.

1. Sign in at [app.cline.bot](https://app.cline.bot) -> **Settings > API Keys** -> **Create API Key**.
2. Export it as `CLINE_API_KEY`.
3. Model ids are `provider/model`, e.g. `anthropic/claude-sonnet-4-6`. Free ids such as
   `cline-free/mimo-v2.6-flash` exist for zero-credit test runs.

Quick reachability check (no SDK involved):

```powershell
curl.exe -X POST https://api.cline.bot/api/v1/chat/completions `
  -H "Authorization: Bearer $env:CLINE_API_KEY" `
  -H "Content-Type: application/json" `
  -d '{"model":"anthropic/claude-sonnet-4-6","messages":[{"role":"user","content":"hi"}],"stream":false}'
```

A wrong/missing key returns `401 {"error":"Unauthorized: ..."}` - that is expected and proves
the endpoint is reachable.

## Commands

Node must be on `PATH` (`C:\Program Files\nodejs`), otherwise transitive `postinstall`
scripts fail.

```powershell
cd cline-sdk-sandbox
npm install

npm test                # layer 1 - tool isolation, offline
npm run test:cline-config # layer 2 - Cline endpoint/auth/model wiring, offline
npm run test:provider   # layer 3 - agent loop against the stubbed provider, offline
npm run test:offline    # layers 1 + 2 + 3 together (CI default)
npm run test:live       # layer 4 - real Cline model, skipped unless CLINE_SDK_LIVE=1
npm run test:all        # everything (live tests self-skip without config)
```

### Layer 4 against the real Cline model

```powershell
$env:CLINE_SDK_LIVE="1"
$env:CLINE_API_KEY="<your key>"
npm run test:live
```

Defaults are Cline-native: `providerId="cline"`, `modelId="anthropic/claude-sonnet-4-6"`.
Override with `$env:PROVIDER_ID` / `$env:MODEL_ID` / `$env:PROVIDER_BASE_URL` when needed,
for example `$env:MODEL_ID="cline-free/mimo-v2.6-flash"` for a zero-credit run.

### Discovering event names

The docs describe event surfaces in prose; assert on the concrete `type` strings instead.

```powershell
$env:CLINE_API_KEY="<your key>"
node dump-events.ts "Show me where the search box is, then finish."
```

## What each layer actually asserts

**Layer 1** - tool name shape (`snake_case`), description length, `inputSchema` presence,
that `z.enum` rejects `"sideways"`, that numeric bounds reject `0` and `2.5`, that optional
fields may be omitted, that `execute()` returns structured JSON, and that `finish` carries
`lifecycle.completesRun` (without it the loop runs to `maxIterations`).

**Layer 2** - starts the SDK against a stub mounted at `/api/v1` and asserts the outbound
request is the documented Cline one: path `/api/v1/chat/completions`, header
`Authorization: Bearer <key>`, `model: "anthropic/claude-sonnet-4-6"`, and our tools present in
the `tools` array. This proves the Cline wiring before you spend a single credit.

**Layer 3** - the strongest offline check. A stub HTTP server speaks `/v1/chat/completions`
and returns a canned `point_at` tool call, then a final message. The test asserts the SDK
(a) sent `point_at` in the request's `tools` array, (b) parsed the tool call, (c) actually ran
`execute()`, (d) passed `{ element_id: "e7", hint: "Search box" }` through intact, and (e) ended
with `status === "completed"`. It handles both streaming (SSE) and non-streaming responses. If
it ever fails, the request log in the assertion message shows the exact wire format for your SDK
version.

**Layer 4** - asserts on **tool calls, never prose**. Checks the model selects `point_at`
with schema-valid args, declines to `click` when only guidance was asked for, and never runs
a tool disabled via `toolPolicies: { click: { enabled: false } }`.

## Gotchas worth knowing

- Assert on `calls` (an explicit recorder) rather than the model's text. Model prose is
  non-deterministic; a tool call is a fact.
- `createTool` defaults: `timeoutMs: 30000`, `retryable: true`, `maxRetries: 3`.
- Returning `{ output, isError: true }` tells the model it failed and lets it retry; *throwing*
  increments the consecutive-mistake counter and can end the run at `mistake_limit`.
- `AgentToolContext` is `{ agentId, conversationId, iteration, abortSignal?, metadata? }`,
  not `{ agentId, runId, toolCallId }` as some older doc snippets show.
- `AgentRunResult` is `{ agentId, runId, status, iterations, outputText, messages, usage, error? }`
  with `status` in `completed | aborted | failed`.
