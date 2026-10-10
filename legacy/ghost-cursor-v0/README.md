# Ghost Cursor - documentation

Ghost Cursor (`package.json` name: `ghost-cursor`, version 0.1.0) is a standalone
Electron desktop prototype. It launches its own Chrome with a private profile on a
CDP debug port and draws an always-visible "ghost cursor" over the real Chrome
window to guide the user where to click and scroll. The user's physical mouse and
keyboard are never driven by the OS: everything the agent does is a CDP protocol
message.

## Index

| Document | What it covers |
| --- | --- |
| [architecture.md](./architecture.md) | Module map, the agent loop, tool vocabulary, state machine, trust boundary, coordinate mapping, logging |
| [tabs-and-address-bar.md](./tabs-and-address-bar.md) | Design and phased implementation plan for teaching the agent about open tabs and each tab's URL ("address bar") |

## Quick start

```powershell
npm install
npm start            # build, then launch Electron + Chrome + the ghost overlay
```

Flags parsed by `src/main/main.ts` (`parseArgs`, main.ts:46):

| Flag | Effect |
| --- | --- |
| `--smoke` | run the scripted end-to-end smoke test, exit 0/1 |
| `--chrome-path=<path>` | use a specific Chromium binary |
| `--start-url=<url>` | page Chrome opens (default `https://www.google.com/`) |
| `--hotkey=<accelerator>` | dialog hotkey (default `Control+Shift+G`) |
| `--planner=ollama` | propose steps with a local Ollama model |
| `--ollama-model=<name>` | model name for the Ollama planner |

## NPM scripts

From `package.json`:

- `npm run clean` - remove `dist/`
- `npm run compile` - `tsc -p tsconfig.json`
- `npm run assets` - copy renderer HTML/CSS into `dist/`
- `npm run build` - compile + assets
- `npm start` - build, then `electron .`
- `npm run smoke` - build, then `electron . --smoke`
- `npm test`, `test:unit`, `test:integration`, `test:all` - build, then `node --test dist/test/...`

> **Known gap:** the test scripts point at `dist/test/unit/` and
> `dist/test/integration/`, but there is no `src/test/` directory in this
> repository yet, so `npm test` currently has nothing to run. `tsconfig.json`
> only includes `src/**/*.ts`.

## Current status

- Working path: launch Chrome over CDP, snapshot the page, move the ghost cursor
  (telegraph), guarded click / scroll / type, Esc and double-Esc stop, JSONL log.
- Not implemented: tab awareness and address-bar (URL) awareness. See
  [tabs-and-address-bar.md](./tabs-and-address-bar.md).
- Source comments reference a "spec" by section number (for example "spec section
  10"). That spec document is **not** part of this repository; the comments are the
  only record of it.
