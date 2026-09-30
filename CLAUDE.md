# galleryLAB

A Windows desktop app (Electron + React + three.js) that turns a folder of photographs into a walkable 3D
gallery designed around them. The full brief is the source of truth for scope; `docs/PROGRESS.md` tracks
milestones M0–M8, `docs/DECISIONS.md` records every choice the brief left open, `docs/DESIGN.md` documents
the interface tokens.

**Session protocol.** "Continue galleryLAB" → read this file, `docs/PROGRESS.md`, `docs/DECISIONS.md`, then
carry on from the next unchecked item. End every session by updating PROGRESS (checkboxes, "Next up") and
DECISIONS, and committing. A milestone is done only when its acceptance criteria pass, tests are green and
the QA shots have been looked at.

## Architecture

```
src/
  shared/           Pure TS used by every process. No Node or DOM imports.
    schemas.ts      zod schemas: project.json, library.json, settings, summaries
    rpc.ts          THE renderer↔main contract (methods + zod in/out), main events, engine events
    engine-protocol.ts  main↔engine message shapes
    names.ts        Windows-safe folder names, collision-safe numbering (property-tested)
    migrate.ts      versioned-document migrations
    batcher.ts      ~10 Hz event batching for high-volume streams
    node/           Node-only shared code (main + engine). Excluded from the web tsconfig.
      atomic-json.ts  temp → fsync → rename writes; versioned reads
  main/             Electron main: windows, lifecycle, Library registry, gallery:// protocol, RPC hub.
                    NEVER heavy work (lint forbids sharp/sqlite/exiftool/onnx imports here).
    index.ts        bootstrap + RPC implementations
    library.ts      Library/projects on disk (Electron-free, unit-tested; trash injected)
    protocol*.ts    gallery://<projectId>/<path>, path containment + realpath check
    engine-host.ts  spawns/restarts the engine utilityProcess, request/response, MessagePorts
    rpc.ts          single ipcMain.handle channel, sender check, zod-parsed input
    window.ts       frameless window, titleBarOverlay, navigation/permission lockdown
  engine/index.ts   utilityProcess (own build entry → out/main/engine.js). All heavy work lands here.
  preload/          contextBridge API (`window.gallery`), typed from shared/rpc.ts; api.d.ts = types
  renderer/         React 19 UI. index.html holds the CSP.
    src/design/     tokens.css (colors/type/space/motion), base.css
    src/components, src/screens, src/state (zustand), src/lib (bridge, format)
design/             data files (rules.json, vocabulary.json — from M2/M3)
tests/              Vitest unit + fast-check property tests (*.test.ts)
e2e/                Playwright Electron tests (*.e2e.ts) + harness.ts
scripts/            qa-shots.ts, render-icon.ts, peek.ts
build/              icon.svg → icon.png (electron-builder resources)
```

Process model: renderer ⇄ (ipc `gallery:rpc`, one channel) ⇄ main ⇄ (parentPort) ⇄ engine. The engine also
gets a direct MessagePort to each renderer (`gallery:engine-port`) for batched high-volume events. Image bytes
never cross IPC; the renderer loads them from `gallery://<projectId>/<relative path>`.

Adding an RPC method: add it to `rpcContract` in `src/shared/rpc.ts` → implement it in the `registerRpc({...})`
object in `src/main/index.ts` (typecheck forces this) → call `window.gallery.invoke('name', input)`.

## Commands

```
npm run dev          electron-vite dev (HMR renderer)
npm run build        build main, engine, preload, renderer into out/
npm run typecheck    tsc for node, web and e2e projects
npm run lint         eslint (flat config)
npm run format       prettier --write
npm test             vitest (unit + property)
npm run e2e          build + Playwright Electron tests (Linux: wrap in xvfb-run -a)
npm run qa:shots     build + screenshots of every screen in both themes → qa/shots/<date>/
npm run check        typecheck + lint + test
npm run pack         unpacked build for this OS (dist/)
npm run dist:win     NSIS installer + portable exe (needs Windows, or Wine incl. 32-bit for NSIS)
```

Headless in the cloud container: `xvfb-run -a -s "-screen 0 1600x1000x24" npx playwright test`.
CI (`.github/workflows/ci.yml`): Linux job runs every check + e2e; Windows job builds NSIS + portable,
smoke-tests the unpacked build, installs silently and launches, and starts the portable exe.

## Conventions

- TypeScript strict + `noUncheckedIndexedAccess`. zod v4 for every boundary (IPC, JSON files, engine messages).
- Prettier: no semicolons, single quotes, width 120.
- All JSON on disk goes through `writeJsonAtomic` / `readJsonVersioned` with a `schemaVersion` and migrations.
- Paths inside a project are relative to the project folder. Project ids are lowercase UUIDs (they are URL hosts).
- User-facing copy: sentence case, plain verbs, one name per action, errors say what happened and what to do.
  No all-caps/eyebrow labels, no middle-dot strings, no arrows on buttons, no monospace for data.
- Renderer never imports Node or Electron (lint rule). Main never imports heavy native modules (lint rule).
- Colors only via tokens in `src/renderer/src/design/tokens.css`; window chrome colors mirror them in
  `src/main/theme.ts`.
- Test hooks via env: `GALLERYLAB_USER_DATA` (isolated userData), `GALLERYLAB_DEFAULT_LIBRARY` (first-run default),
  `GALLERYLAB_EXECUTABLE` (harness launches a packaged build), `GALLERYLAB_HIDDEN` (don't show the window).

## Gotchas

- npm 10 (bundled with Node 22) crashes with `Cannot read properties of null (reading 'edgesOut')` when adding
  some dev deps; use `npx -y npm@11 i -E -D <pkg>` to add packages. `npm ci` from the lockfile works with npm 10.
- In the cloud container Electron's postinstall download fails (undici through the proxy). Fix: curl
  `https://github.com/electron/electron/releases/download/v<ver>/electron-v<ver>-linux-x64.zip`, unzip into
  `node_modules/electron/dist`, and write `electron` to `node_modules/electron/path.txt`.
- Playwright's bundled browsers are not the preinstalled ones; for plain Chromium scripts pass
  `executablePath: '/opt/pw-browsers/chromium'` (see scripts/render-icon.ts, env `PW_CHROMIUM`). Electron tests
  use Electron's own Chromium, no browser download needed.
- electron-builder `--win nsis` on Linux needs 32-bit Wine (not installable here); `--win portable` works with
  64-bit Wine. The installer is built and verified on the Windows CI runner.
- Launch Electron with the project directory (not `out/main/index.js`) or `app.getVersion()` reports
  Electron's version.
- The Library folder watcher reacts to our own writes; `Library.persist` skips identical writes so it settles.
- The sandboxed preload must be one self-contained CJS file (`externalizeDeps: false` for preload).
- Standard schemes lowercase the host: keep project ids lowercase.
- Renderer-only packages are devDependencies (Vite bundles them); only runtime deps of main/engine go in
  `dependencies`, so the packaged app stays small.
