# Shift Memory console — design system

Rewritten 2026-11-07 after the visual world changed from "night-shift control room" to an
enterprise workspace register (Notion / Pylon). Mode: Operate. Tokens live in
`src/styles.css` `:root`; dark values follow `prefers-color-scheme` or `data-theme`.

## Palette (light)
| Role | Token | Value |
|---|---|---|
| Page / surface | `--page` / `--ground` | `#f7f7f5` / `#ffffff` |
| Panel fill, hover | `--panel` / `--hover` | `#f4f4f1` / `#f0f0ec` |
| Hairlines | `--line-soft` / `--line` / `--line-strong` | `#ededea` / `#e5e5e1` / `#d4d4cf` |
| Ink | `--ink` / `--ink-2` / `--ink-3` | `#1f1f1d` / `#4f4e4a` / `#6b6a66` (4.6:1 on white) |
| Accent and links | `--accent` / `--link` | `#2563eb` |
| Wearer series, fixed order | `--w1…--w6` | `#2a78d6` `#eb6834` `#1baf7a` `#c98500` `#d55181` `#6250d6` |
| Places / entities | `--place` / `--entity` | `#0f8a5f` / `#5b4bd0` |
| Status fills and text | `--critical*` `--warning*` `--good*` | fill `#d03b3b` `#fab219` `#0ca30c`; text `#a32626` `#7a5300` `#0b7a0b`; tints `#fdeaea` `#fff4d6` `#e8f7e8` |

Series come from the validated light categorical palette in the dataviz skill; dark mode uses
that palette's dark steps. Status always ships with an icon or a word. Wearer color follows the
device, never its rank. Colored text is avoided: wearers appear as a dot plus ink text.

## Type
Inter 400–600 for everything; JetBrains Mono only for times, IDs, and readings. Body 14px,
panel heads 14px semibold, drawer title 16px, alert count 20px, metadata 12–13px. Tabular
numerals on. Handoff section heads are 12px uppercase tracked, the one label-style heading.

## Shape and depth
6px radii, 1px hairlines, no card borders unless selected, one soft shadow (`--shadow`) for the
tooltip and drawer. Primary action is the ink-filled button; everything else is outlined.

## Signature move
The floor schematic (`src/floor.ts`) is the product; since 2026-11-07 it owns the width and the
operations rail is gone (history: commit fc75319). Zones come from the asset registry (the first
segment of each asset's location) so the floor is laid out before the first photo, plus any
place the model names that no registry asset explains. Assets are monospace tiles that carry
state: last change in amber, else last seen and by whom, dashed and faded while unseen this
window, red edge while an alert is open; the zone header counts seen/total. Events are 44×33
photo chips bordered in the wearer's color (dots where chips would collide) on a vertical time
axis under the asset they touched. Time is linear while the shift fits; once it does not, gaps
cap at 56px and idle stretches of 30 min or more become a labeled break. Wheel zooms the axis
around the cursor, double-click or Fit resets. NEXT is the operator's walk as a bezier, CHANGES
are amber ticks. Clicking a tile enters trace mode: everything else dims to 22%, the full path
stays. Hover shows the photo card; click opens the detail panel over the floor's right edge and
the canvas reflows. Arrow keys step through the shift. Canvas colors are read from the tokens.

## Motion
Positions ease (110 ms exponential), so zoom, reflow and new arrivals move instead of snapping.
A new photo rises from the "now" edge, the path draws itself to it over 650 ms, and a ring
breathes out once. The detail panel slides 16px. Honors `prefers-reduced-motion` for CSS; the
canvas easing is short enough to keep.

## States
Connection dot amber/green/red plus a staleness band when not live. Status chips are tinted
pills with ink text. Empty states are sentences, and filter-caused ones name the cause and
offer a one-click reset. "All clear" is a green sentence with a dot, legible across a room.
