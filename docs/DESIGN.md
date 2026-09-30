# Interface design

The chrome is the gallery's front of house: quiet, exact, clean and light. Its one memorable idea is that
every project is an architectural model on a plinth. Tokens live in `src/renderer/src/design/tokens.css`;
nothing in the renderer uses a raw color, size or duration that is not a token.

## Color

| Token       | Light                 | Darkroom      | Use                                                          |
| ----------- | --------------------- | ------------- | ------------------------------------------------------------ |
| `--ground`  | Paper `#F7F8F7`       | `#262626`     | window ground, title bar, caption-button overlay             |
| `--surface` | Plaster `#ECEEED`     | `#313131`     | raised surfaces: notices, segmented controls, pressed states |
| `--text`    | Graphite `#22272B`    | `#E7E7E5`     | text                                                         |
| `--text-2`  | Slate `#646D73`       | `#A3A3A1`     | secondary text, facts                                        |
| `--divider` | Rule `#D5D9DB`        | `#3D3D3D`     | dividers, sparingly                                          |
| `--accent`  | Cutting-mat `#2F6B57` | `#7FBFA6`     | controls only: primary buttons, focus rings, text-field rule |
| `--danger`  | `#9B2C22`             | `#F08A7E`     | destructive actions                                          |
| `--card-*`  | white card            | lit gray card | the plinth/model drawing                                     |

- Darkroom is neutral: no hue in grounds or surfaces, so photographs are judged against gray.
- While a project is open (from M1), `--accent` becomes a restrained tone sampled from its exhibition palette,
  checked at ≥ 4.5:1 against the ground. Accent never sits next to a photograph.
- The theme follows the OS (`nativeTheme.themeSource = 'system'`) with a manual override in Settings. The
  window's `backgroundColor` and `titleBarOverlay` follow `src/main/theme.ts`, which mirrors `--ground`/`--text`.

## Type

- Newsreader (variable, optical sizes) — project titles, exhibition titles, room names, dialog titles. Class `display`.
- Libre Franklin (variable) — everything else, with tabular lining figures.
- Sizes only from the scale 12, 14, 16, 18, 21, 24, 36, 48, 60, 72 (`--size-*`).
- Sentence case, left-aligned, ragged right. Long text 45–75 characters per line.
- Bundled locally via @fontsource-variable; no network fonts.

## Space and shape

4 px base (`--space-1` … `--space-9`: 4, 8, 12, 16, 24, 32, 48, 64, 96). Radii 3 px (controls) and 6 px
(dialogs, menus, focus ring). Shadows only where something floats above the page (dialogs, menus).

## Motion

Critically damped springs, no bounce; panels 180–280 ms (`--duration-panel` 220 ms). Everything is
interruptible. `prefers-reduced-motion` turns moves into 200 ms crossfades. Nothing moves unless the user
acts, except the one orchestrated moment (M5).

## Components (M0)

- Title bar: 44 px draggable strip. Wordmark left; actions right, stopping at `env(titlebar-area-width)` so the
  native caption buttons are never covered.
- Buttons: primary (accent fill), quiet (rule outline), danger. 32 px high, 14 px medium text, no icons or arrows.
- Project card: plinth drawing (16:11 area), title in Newsreader 21, two fact lines in Slate 14. Focus shows a
  2 px accent ring; no hover effects. F2 renames in place, Delete asks to move to the Recycle Bin, the context
  menu offers Rename, Show in Explorer, Move to Recycle Bin. Arrow keys, Home and End move between cards.
- Dialog: centered, Newsreader 24 title, secondary description, actions right-aligned. Scrim, fade and a 6 px rise.
- Notices: text-only at the bottom left on Plaster; errors keep a 2 px danger rule and stay until dismissed.

## Avoid

All-caps or eyebrow labels, middle-dot metadata strings, arrows appended to buttons, monospace for data,
identical rounded cards with gray drop shadows, gradient washes, hover animations on every card, Mica or
acrylic behind photos, anything chromatic next to a photograph.
