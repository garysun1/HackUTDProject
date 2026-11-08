# Reflection console — design system

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
Two views behind one switch, the shift line and the site map (decisions 0028, 0030).

The shift line (`src/floor.ts`) is the primary view. Photos are 72×54 chips on one horizontal
line in time order, bordered in the wearer's color, red with a soft glow while an alert is open,
time and wearer beneath; gaps of 30 minutes or more compress into a labelled "quiet" break.
Four kinds of thing appear: photo, equipment, issue, note. Equipment pills (registry name in plain
words, type and code on hover) and issue pills (alert text in sentence case, red tint while open,
a green check once acknowledged) sit in packed lanes above the line and thread down to every
photo they touch; open issues take the lane nearest the line. Notes (what the wearer said) are
quote cards below their photo. A change is an amber arc from the earlier photo of that equipment
to the later one, its text printed once at the apex. Hovering a photo reveals dashed links to
photos that share an identifier read in the scene (ticket numbers, asset tags) or look alike by
embedding. Clicking a pill follows that equipment or issue: everything else dims to a quarter.
Clicking a photo opens the detail panel, which holds place, people, objects and text read. The
view fits the whole line while readable, otherwise keeps the newest photos at the right or
centres the selection; wheel zooms, shift-wheel or drag pans, double-click or Fit returns.

The site map (`src/map.ts`) is the second view: tracks per wearer, photo pins with thumbnails,
alerts burning until acknowledged, clusters that open the shift line scoped to those photos.

## Motion
Nothing on the shift line moves except arrivals: a new photo slides in from the right over about
a third of a second, its threads draw down over 650 ms, and a ring breathes out once. The view
eases (160 ms) when it refits. On the map a new pin drops in and an acknowledged alert flashes
green before settling. The detail panel slides 16px. Honors `prefers-reduced-motion` for CSS.

## States
Connection dot amber/green/red plus a staleness band when not live. Status chips are tinted
pills with ink text. Empty states are sentences, and filter-caused ones name the cause and
offer a one-click reset. "All clear" is a green sentence with a dot, legible across a room.
