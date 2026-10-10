# Cline SDK spike (spec 8.7)

Result: **Cline SDK kept as the planner.** The fallback loop (`shell/src/agent/fallbackPlanner.ts`) stays behind the same `Planner` interface and is selected with `PLANNER_IMPL=fallback`.

| Check | Result |
| --- | --- |
| 1. Runs from Node (not CLI) | Yes. `@cline/sdk` 0.0.92, `new Agent({...})` |
| 2. Custom tool called, result returned | Yes. `node shell/scripts/ollama-spike.mjs` with local Ollama `gemma4:12b`: called `point_at({element_id:"e7"})`, then `finish`, status `completed`, ~23 s |
| 3. Built-in tools off | Yes. `Agent` only exposes the tools passed in (no shell/file/browser/MCP) |
| 4. Events | `run-started, turn-started, assistant-reasoning-delta, assistant-text-delta, tool-started, tool-finished, turn-finished, run-finished` |
| 5. Inside Electron main | Yes. Electron 38 (Node 22); ESM SDK loaded by native `import('@cline/sdk')` from the CJS main bundle |
| 6. Abort | `agent.abort()` wired to Esc-Esc, overlay loss, caps and tool `stop` |

Model config (`.env`): `PLANNER=ollama`, `PLANNER_URL=http://127.0.0.1:11434/v1`, `PLANNER_MODEL=gemma4:12b`, provider `openai-compatible`.
