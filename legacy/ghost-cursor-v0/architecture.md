# Architecture

## 1. What the system is

An Electron app (main process + two renderer windows) that spawns its **own**
Chrome with `--remote-debugging-port` and a private `--user-data-dir`
(`chromeLauncher.ts:194`), attaches to it over CDP with `puppeteer-core`
(`bridge.ts:87`), and draws a full-screen ghost cursor overlay on top of it. The
agent perceives the active page, plans one step, has that step validated in code,
telegraphs it with the cursor, then executes it over CDP.

## 2. The one rule the whole design hangs on

> Only `src/main/browser/bridge.ts` may touch the browser. The planner only
> *proposes*, `guardrails.ts` is the only door to a real action, and `core.ts` is
> the only dispatcher.

See the file headers at `types.ts:4` and `bridge.ts:20`. Everything below follows
from that: adding a capability means threading it through
planner -> guardrails -> bridge, never reaching around them.

## 3. Module map

| Path | Responsibility |
| --- | --- |
| `src/main/main.ts` | Boot order, shutdown order, CLI flags, single-instance lock |
| `src/main/logger.ts` | `Logger` (logger.ts:17): append-only JSONL file **plus** in-memory records for tests |
| `src/main/smoke.ts` | Scripted end-to-end check used by `npm run smoke` |
| `src/main/browser/chromeLauncher.ts` | `findChromePath` (86), `getFreePort` (102), `buildChromeArgs` (159), `launchChrome` (194) |
| `src/main/browser/bridge.ts` | The only module that touches the page: snapshot, click, scroll, type, Enter, navigate, geometry |
| `src/main/browser/snapshotScript.ts` | `collectSnapshot` (53), `resolveElementId` (336) - evaluated inside the page |
| `src/main/browser/listenerScript.ts` | `installPageListener` (23), `PageEvent` (11) - one-way user-event reporting |
| `src/main/browser/coordinates.ts` | `buildGeometry`, `calibrationOk`, `CALIBRATION_TOLERANCE_PX` (36), CSS px -> screen DIP |
| `src/main/agent/core.ts` | `AgentCore`: the single loop, task lifecycle, Esc handling, dispatch |
| `src/main/agent/guardrails.ts` | The single validation door: `allowedTools` (64), `validateToolCall` (119) |
| `src/main/agent/stateMachine.ts` | The transition table (21) and derived `mode` (56) |
| `src/main/agent/planner.ts` | `Planner` contract, `describeSnapshot`, `wrapPageData`, `PAGE_CONTENT_IS_DATA` |
| `src/main/agent/heuristicPlanner.ts` | Default deterministic planner (offline, always available) |
| `src/main/agent/ollamaPlanner.ts` | Optional local-model planner; falls back to the heuristic one on any failure |
| `src/main/agent/intent.ts` | Intent classification; the **only** origin of a typing grant |
| `src/main/agent/typingGrant.ts` | `GrantStore` (19): holds at most one single-use grant |
| `src/main/agent/sanitize.ts` | Builds the planner-facing `SanitizedSnapshot` (37), `quoteData` (21) |
| `src/main/agent/telegraph.ts` | `telegraph` (42): move the ghost, pause >= 400 ms, pulse |
| `src/main/ui/overlayWindow.ts` | Transparent, always-on-top ghost window: `move`, `pulse`, `hint`, `thinking`, `offscreen` |
| `src/main/ui/dialogWindow.ts` | The dialog panel: `say`, `echoUser`, `setStatus`, `toggle`, global hotkey |
| `src/shared/types.ts` | Every shared type, the tuning constants (231-239) and the IPC channel names (213) |
| `src/renderer/*` | `overlay.html/css/js` and `dialog.html/css/js` + `preload.js` |

Runtime shape: one Electron main process, two Electron renderers (overlay,
dialog), and Chrome as a separate spawned process tree that the app kills with
`taskkill /T` on shutdown (`chromeLauncher.ts:230`).

<!-- CONTINUE -->
