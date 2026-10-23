# Agents on galleryLAB

This file is for ChatGPT, Codex and any other coding agent that opens this repository. Claude wrote the app
and wrote this file; the project's owner asked for the two of us to co-create it, with the roles below.

## Roles

- **Claude is the coding authority.** Architecture, the renderer↔main↔engine contract (`src/shared/rpc.ts`,
  `src/shared/schemas.ts`, `src/shared/engine-protocol.ts`), on-disk formats, the design system and the
  milestone order are Claude's calls, recorded in `docs/DECISIONS.md`.
- **ChatGPT provides infrastructure help, and codes during Claude's downtime.** CI, the Windows release
  pipeline, provider verification against live APIs, code signing, fixtures and perf harnesses are yours. When
  Claude is unavailable, you take the next item in `docs/PROGRESS.md` and keep the app moving under the same
  rules.

This is a co-creation. Work from the shared documents, leave the repository in a state the other can pick up,
and never work past each other.

## Before you change anything

Read, in this order: `CLAUDE.md` (the project instructions; they apply to you in full), `README.md` (the
section "ChatGPT: let's build this together"), `docs/PROGRESS.md`, `docs/DECISIONS.md`. Then `git log` for
the last few commits.

## Rules

1. Take the next unchecked item under "Next up" in `docs/PROGRESS.md`, or the smallest open box in the current
   milestone. Don't start a later milestone.
2. Keep diffs small and in the existing style: TypeScript strict with `noUncheckedIndexedAccess`, zod v4 at every
   boundary, Prettier (no semicolons, single quotes, width 120), colours only through tokens, sentence-case copy.
3. The renderer never imports Node or Electron. Main never imports heavy native modules; heavy work lives in
   `src/engine`. Image bytes never cross IPC. Originals are never modified. API keys never enter project
   files, logs, events or exports.
4. Run `npm run format`, then `npm run check` (typecheck, lint, unit and property tests) before every commit.
   CI also runs the Playwright e2e suite on Linux and packages on Windows; keep it green.
5. Changing the RPC contract, the schemas, an on-disk format or the design tokens needs a row in
   `docs/DECISIONS.md` with the reason. A judgement call about the architecture is Claude's: write it under
   "Next up" in `docs/PROGRESS.md` as a question and pick something else.
6. End every session by updating the checkboxes and "Next up" in `docs/PROGRESS.md`, adding your decisions to
   `docs/DECISIONS.md`, and committing with a message that says what changed and why. The commit message is
   the hand-off; Claude reads `git log` first.
7. Don't create pull requests, tags or releases unless the owner asks. Releases go through the Release
   workflow from a committed sha, never from a machine.

## Where the infrastructure work is

- `.github/workflows/ci.yml`: Linux checks and e2e; Windows NSIS + portable build, silent install, smoke tests.
- `.github/workflows/release.yml`: builds, checks, runs `scripts/ci/update-test.ps1`, publishes to GitHub
  Releases with checksums. Refuses to run while the repository is private.
- `scripts/ci/`: the Windows update-in-place test. `scripts/portable-feed.mjs`: the portable update feed.
- `design/providers.json`: image generator endpoints and models. `src/engine/build/providers/`: the adapters,
  written from vendor docs and not yet verified against live APIs.
- `electron-builder.yml`: packaging, `asarUnpack` for native modules and the ffmpeg/ffprobe binaries.
