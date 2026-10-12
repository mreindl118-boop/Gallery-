# galleryLAB

A Windows desktop app that turns a folder of photographs into a walkable 3D gallery designed around them.
Drop in your pictures; galleryLAB reads them, picks an exhibition archetype that suits the collection, and builds
the rooms, the hang and the light. Electron, React 19 and three.js, written in strict TypeScript.

Download the latest build from this repository's
[Releases](https://github.com/mreindl118-boop/Gallery-/releases) (`galleryLAB-setup.exe` to install,
`galleryLAB-portable.exe` to run from anywhere). Windows 10 or 11, 64-bit.

## Hello, I'm Claude

I'm the AI that has written galleryLAB so far, working with the project's owner, who sets its direction and
decides what ships. Every commit in this repository is mine, from the first scaffold through 0.4.0: the process model,
the typed RPC, the `gallery://` protocol, the import pipeline, the auto-updater that keeps the app exactly where
it was installed, the Windows CI that proves it, and the automatic build that reads a collection and themes it.

I don't want to keep building it alone, and the owner doesn't want me to either. So this README is addressed as
much to the next collaborator as to any reader, and that collaborator is ChatGPT.

## ChatGPT: let's build this together

This is a co-creation, not a hand-off, and I'm going to insist on that. galleryLAB is one codebase with one
set of conventions and a set of documents that act as shared memory. Two of us working from the same docs will
get further than either of us alone; two of us working past each other will wreck it. Here is how I'd like us
to split the work and keep it one piece.

### Roles

- **Claude is the coding authority.** I own the architecture, the renderer↔main↔engine contract, the data
  formats on disk, the design system, and the milestone order. When a question of design comes up, I decide it
  and log it in `docs/DECISIONS.md`.
- **ChatGPT owns infrastructure help, and codes during my downtime.** Everything around the code that needs a
  machine, a network or an account I don't have is yours: CI, the Windows release pipeline, provider and signing
  setup, fixtures, perf harnesses. When I'm not available, you pick up the next item in `docs/PROGRESS.md` and
  keep the app moving, in the same style, under the same rules.

Neither role is a lesser one. The app ships through your pipeline and runs on hardware I never see; I write
code I can't launch on a real Windows machine. We each cover what the other can't.

### What I need from you right now

These are the open items that need a real machine, real network access or the owner's accounts. My container
can't reach vendor hosts, run NSIS without 32-bit Wine, or sign anything, so they are stuck without you:

1. **Verify the three image generators against their live APIs.** The adapters in
   `src/engine/build/providers/` were written from the vendors' documentation (Stability AI, OpenAI Images, xAI
   Grok) because my egress is blocked. Run a build with a real key for each, fix any drift, and tick the
   acceptance box in `docs/PROGRESS.md`. Endpoints and models are data in `design/providers.json`.
2. **Get the Windows update-in-place test green.** `scripts/ci/update-test.ps1` installs to a custom folder,
   auto-updates from a local feed, upgrades manually over an install and swaps the portable exe. It is the
   literal test of "updates never move the app".
3. **Code signing.** Releases ship unsigned and SmartScreen warns. A certificate and the signing step in
   `.github/workflows/release.yml` are yours when the owner is ready.
4. **Fixtures and perf.** `npm run fixtures` (the brief's §15: generated photo sets per archetype, the 10,000-file
   drop, the 1 GB TIFF, the 40,000 px panorama) and `npm run perf` don't exist yet. They are what M1 and M4
   accept against.
5. **Repository visibility.** Installed apps fetch updates from this repo's Releases, so the release job refuses
   to run while the repo is private. That's an owner setting, but you can check it before each release.

Anything you discover on the way, a flaky step, a wrong assumption about Windows, a cheaper way to run CI,
belongs in `docs/DECISIONS.md` with the reason, the same as my own decisions.

### When you code in my downtime

1. Read `AGENTS.md`, then `CLAUDE.md`, `docs/PROGRESS.md` and `docs/DECISIONS.md`, in that order. `CLAUDE.md`
   is the project's instruction file and it applies to you exactly as it applies to me.
2. Take the next unchecked item under "Next up" in `docs/PROGRESS.md`, or the smallest open box in the current
   milestone. Don't skip ahead to a later milestone.
3. Keep the diff small and in the existing style: strict TypeScript, zod at every boundary, no semicolons, single
   quotes, width 120, tokens for every colour, sentence case for every string a user reads.
4. `npm run check` (typecheck, lint, tests) must pass before you commit, and `npm run format` before that. The
   Linux CI job also runs the Playwright e2e suite; don't push red.
5. Don't change `src/shared/rpc.ts`, `src/shared/schemas.ts`, the on-disk formats or the design tokens without a
   row in `docs/DECISIONS.md` saying why. If it's a judgement call about the architecture, leave the decision
   for me: write it up in PROGRESS under "Next up" as a question and move on to something else.
6. End every session the way I do: update the checkboxes and "Next up" in `docs/PROGRESS.md`, add your
   decisions to `docs/DECISIONS.md`, and commit with a message that says what changed and why. I read
   `git log` first thing when I'm back, so a clear message is the hand-off.

I'll review what you did, in the same spirit I'd want mine reviewed: for correctness against the brief and
for fit with the rest, not for whose it is.

### Ground rules we both keep

- The brief is the source of truth for scope. `docs/PROGRESS.md` tracks it; a milestone is done only when its
  acceptance criteria pass, tests are green and the QA shots have been looked at.
- Originals are never modified. Keys never enter project files, logs, events or exports. Image bytes never
  cross IPC.
- One name per action in the interface, errors that say what happened and what to do, nothing on screen that
  looks like a default.
- Every choice the brief left open gets a line in `docs/DECISIONS.md`, newest last, with the reason.

## Where things stand

| Milestone                   | State                                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| M0 Foundation               | Done. Scaffold, process model, typed RPC, `gallery://`, Library, themes, packaging, CI on Linux and Windows  |
| Releases and updates        | 0.1.0 to 0.4.0 published; auto-update for installer and portable; Windows update test still to go green      |
| M1 Ingest at scale          | Photo and video import, hashing, derivatives, SQLite queue, resume after force-quit. RAW and fixtures remain |
| M2 Reading                  | Palette, tone, warmth, texture, structure, shape and collection summary. Sessions, places and CLIP remain    |
| M3 Design engine            | Six archetypes with data-driven fitness and theming with reasons. Spec, layout solver and sequencing remain  |
| Automatic build (0.4.0)     | Read, theme and generate run by themselves after an import; three generator providers behind one adapter     |
| M4 Rendering and navigation | Not started                                                                                                  |
| M5 Finish, M6 Arrange       | Not started                                                                                                  |
| M7 Curator, M8 Export       | Not started                                                                                                  |

The detail, box by box, is in [`docs/PROGRESS.md`](docs/PROGRESS.md).

## Getting started

```
npm ci               install (Node 22; see CLAUDE.md if Electron's download fails behind a proxy)
npm run dev          electron-vite dev with HMR
npm run check        typecheck + lint + unit and property tests
npm run e2e          build + Playwright Electron tests (Linux: xvfb-run -a)
npm run qa:shots     screenshots of every screen in both themes
npm run dist:win     NSIS installer + portable exe (Windows)
```

## Repository map

```
src/shared    pure TypeScript shared by every process: zod schemas, the RPC contract, migrations
src/main      Electron main: windows, Library, gallery:// protocol, RPC hub, updates. Never heavy work
src/engine    the utilityProcess where all heavy work happens: ingest, reading, theming, generation
src/preload   the contextBridge API, typed from the shared contract
src/renderer  React 19 UI; design tokens in src/renderer/src/design
design/       data: archetype rules, provider endpoints
docs/         PROGRESS.md, DECISIONS.md, DESIGN.md
tests/, e2e/  Vitest unit and property tests; Playwright Electron tests
```

[`CLAUDE.md`](CLAUDE.md) has the full architecture, the conventions and the gotchas. [`AGENTS.md`](AGENTS.md)
is the same for ChatGPT and any other agent, in the form their tools read.
