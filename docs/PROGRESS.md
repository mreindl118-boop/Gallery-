# Progress

Milestones from the brief (§16). A milestone is done only when every acceptance box is ticked, tests are
green, and its QA shots have been reviewed.

**Next up:** M1 Ingest at scale — add better-sqlite3 (WAL) job queue in the engine, then discovery → identify →
hash → store → metadata → derivatives, the Import view, and `npm run fixtures`. Start by confirming the
Windows CI run for the M0 installer/portable boxes below.

## M0 Foundation

Scaffold, process model, typed RPC, custom protocol, Library and project create/rename/delete, tokens, fonts
and themes, frameless window, Library empty state, lint/typecheck/test scripts, packaging.

- [x] electron-vite + TypeScript strict + React 19 scaffold; main, engine (utilityProcess), preload, renderer entries
- [x] Typed RPC: zod contract in `src/shared/rpc.ts`, validated in preload and main; errors returned as values
- [x] Engine utilityProcess with request/response, crash restart with backoff, MessagePort per renderer, 10 Hz batching
- [x] `gallery://` protocol: privileged standard/secure/fetch/stream/CORS; path containment + realpath check (property-tested)
- [x] First run: choose Library location (default `Pictures\galleryLAB`); missing/unwritable Library handled
- [x] Library registry (`library.json`) rebuilt by rescan; folder watcher picks up changes made in Explorer
- [x] Projects: create (folder layout per §4), rename (folder follows, collision-safe, case-only), delete to Recycle Bin
- [x] Atomic JSON (temp → fsync → rename, retry on EPERM/EBUSY) with schema versions and migrations
- [x] Design tokens (`tokens.css`, `docs/DESIGN.md`), Newsreader + Libre Franklin bundled locally, light + Darkroom themes following the OS with manual override
- [x] Frameless window with native caption buttons (`titleBarOverlay`) tinted to the theme; no menu bar
- [x] Security: contextIsolation, sandbox, no nodeIntegration, strict CSP, navigation/window-open/permission lockdown
- [x] Library empty state and project grid (plinth drawing per project, keyboard navigation, F2/Delete, context menu)
- [x] Scripts: typecheck, lint, format, test, e2e, qa:shots, pack, dist:win
- [x] Packaging config: NSIS + portable, asarUnpack for sharp/@img/exiftool/better-sqlite3/onnxruntime
- [x] **Accept:** installer and portable builds launch on Windows (CI run 36736464375, job `windows`: NSIS built, silent install + launch smoke test, portable exe started)
- [x] **Accept:** projects appear, rename and delete on disk (e2e `library.e2e.ts`)
- [x] **Accept:** theme switching works and persists (e2e)
- [x] **Accept:** all checks pass (typecheck, lint, format, 26 unit/property tests, 6 e2e tests)

QA log (M0):

- Pass 1 (2026-09-30): About showed Electron's version (harness launched `out/main/index.js`); rename field
  shifted the facts by 1 px; theme radios went stale when the theme changed elsewhere; the empty state had two
  "New project" buttons; cards had too much air between model and title. All fixed.
- Pass 2 (2026-09-30): Library, empty, first-run, menu, rename, delete confirmation and settings reviewed in
  both themes. Holds up; Darkroom plinths read as a lit white-card model on neutral gray.
- Deferred to M5: drag-to-reorder projects (the `projects.reorder` RPC and persistence exist), plinth models
  of generated galleries, the orchestrated first-generation moment.

## Releases

- [x] 0.1.0 published (private repo release, installer + portable + checksums)
- [x] Automatic updates (0.1.1): installer via electron-updater pinned to its install folder; portable replaces itself at the same path; Settings → Updates
- [ ] Windows CI update-in-place test green (installer auto-update into custom folder, manual upgrade, portable)
- [ ] Owner setup: make `mreindl118-boop/Gallery-` public (the release workflow checks)
- [ ] 0.1.1 published to Gallery- Releases

## M1 Ingest at scale

- [ ] Import modes: copy (default) and reference; free-space check, suggest Reference above 20% of free space, stop cleanly on disk full
- [ ] Discover (streamed walk), identify by magic bytes, streaming hash, duplicates skipped and reported
- [ ] Store into `originals/` preserving subfolders (temp → rename); reference mode records path + hash; Relink by hash
- [ ] Metadata via exiftool-vendored pool, incl. XMP sidecars
- [ ] Derivatives via sharp (LQIP 32, thumb 512, display 2048, focus 4096 WebP, sRGB, oriented, stripped); lazy DZI > 24 MP
- [ ] HEIC via heic-decode; RAW via largest embedded preview
- [ ] SQLite (WAL) job queue; idempotent stages keyed by content hash; resume after force-quit
- [ ] Separate I/O and CPU pools, megapixel-weighted semaphore, configurable `limitInputPixels` (default 1 GP)
- [ ] Pause, resume, cancel; taskbar progress; Library card progress
- [ ] Bursts/near-duplicates via perceptual hash + capture-time proximity
- [ ] Import view: virtualized contact sheet (LQIP first), one progress line, Issues list with reasons and Retry
- [ ] Repair project rebuilds `.gallery/`
- [ ] `npm run fixtures` (§15)
- [ ] **Accept:** a 10,000-file / 50 GB fixture drop imports without a crash
- [ ] **Accept:** renderer has no long tasks over 50 ms throughout
- [ ] **Accept:** engine memory stays under 2.5 GB
- [ ] **Accept:** force-quit mid-import and relaunch resumes with no duplicates
- [ ] **Accept:** a 1 GB TIFF and the 40,000 px panorama process
- [ ] **Accept:** duplicates and bad files reported correctly
- [ ] **Accept:** first thumbnails appear within about 2 s

## M2 Reading

- [ ] Palette (k-means++ in OKLab, 6 weighted swatches), tone, warmth, texture, structure, shape, context
- [ ] Sessions (3 h gap) and places (~1 km GPS clusters)
- [ ] Optional local CLIP: resumable download to app data, removable; ONNX Runtime CPU/DirectML; zero-shot tags from `design/vocabulary.json`
- [ ] Collection-level features and variety score
- [ ] Photo info panel shows every metric
- [ ] **Accept:** each fixture set lands in its expected feature ranges (tests)
- [ ] **Accept:** the photo info panel shows every metric
- [ ] **Accept:** CLIP runs offline after its download
- [ ] **Accept:** a 10,000-photo project analyzes in the background without blocking import or UI

## M3 Design engine (rules path)

- [ ] `ExhibitionSpec` and `Overrides` zod schemas in `src/shared/spec.ts`
- [ ] Six archetype plugins with fitness functions; seeded tie-break; lock support
- [ ] Translation rules as data (`design/rules.json`) + pure functions, every output with a reason
- [ ] Restraint limits enforced (§8.3)
- [ ] Grouping, sequencing (NN + 2-opt), selection (MMR above 400), procession roles
- [ ] Layout solver in `src/shared/layout/` (25 cm grid, openings, segments, hang, light rig, stations)
- [ ] SVG plan-view render for debugging
- [ ] **Accept:** property tests pass over at least 5,000 seeds
- [ ] **Accept:** each archetype's fixture set selects that archetype
- [ ] **Accept:** spec + layout for 300 works generates in under 1 s

## M4 Rendering and navigation

- [ ] Color-true prints (unlit, toneMapped false, sRGB), AgX environment, procedural materials
- [ ] Light rigs per archetype, per-work light pools, N8AO, Nocturne bloom and reflections, exterior views
- [ ] Portal culling, merged/instanced geometry, texture LRU streaming (512/2048/4096)
- [ ] Quality presets auto-detected
- [ ] Walk, look closer, lightbox (deep zoom), tour, model; mouse, keyboard, controller
- [ ] **Accept:** `npm run perf` meets the budgets
- [ ] **Accept:** reference chart face-on within ΔE2000 < 2
- [ ] **Accept:** walk, look closer, lightbox, tour and model work with mouse, keyboard and controller

## M5 Finish

- [ ] Library shows each project's white-card model on its plinth; drag to reorder
- [ ] Descent from model into the entrance; the orchestrated first-generation moment (skippable)
- [ ] Project accent sampled from the exhibition palette (≥ 4.5:1 on Paper)
- [ ] **Accept:** qa:shots reviewed and iterated at least twice, findings logged
- [ ] **Accept:** a keyboard-only run-through works
- [ ] **Accept:** reduced motion is honored
- [ ] **Accept:** nothing on screen looks like a default

## M6 Arrange

- [ ] Plan drawing (SVG) with drag between walls/rooms, reorder/rename rooms, pin, exclude, hero
- [ ] Controls: Mood, Density, Warmth, Daylight, Scale, Organize by, Archetype
- [ ] Regenerate, Variants (three models side by side), undo/redo, spec history
- [ ] Integrate vs Re-curate; Unhung tray; Why this design; Collection grid; Settings (full)
- [ ] **Accept:** every arrange action undoes
- [ ] **Accept:** overrides survive Regenerate
- [ ] **Accept:** Integrate places new photos without moving pinned works
- [ ] **Accept:** Variants shows three clearly different designs

## M7 Curator

- [ ] Opt-in per project; key in `safeStorage`; token/image estimate before running
- [ ] Stage 1 readings (Haiku, batched, metadata-free thumbnails); Stage 2 synthesis (Sonnet, structured output, zod, repair retry, rules fallback)
- [ ] Versioned prompts in `src/engine/curator/prompts/`; editable price config
- [ ] **Accept:** with a key, a 200-photo project gets a valid spec with titles and room intros in the specified voice
- [ ] **Accept:** without a key, or offline, nothing breaks
- [ ] **Accept:** tests prove outbound payloads carry no EXIF or GPS
- [ ] **Accept:** the key never appears in project files, logs or exports

## M8 Export and extras

- [ ] Standalone static gallery (folder/zip) + Preview export via local server
- [ ] Stills up to 4K; tour video WebM 1080p/1440p
- [ ] Project archive zip (optionally without `.gallery/`) and archive import
- [ ] Watched Source folder (chokidar, write-finish detection, new works to Unhung)
- [ ] Optional ambient sound (procedural room tone, reverb sized to the room; off by default)
- [ ] **Accept:** an exported gallery runs from a static host
- [ ] **Accept:** stills and tour video export
- [ ] **Accept:** a project archive round-trips
- [ ] **Accept:** the watched folder picks up new files once they finish writing
