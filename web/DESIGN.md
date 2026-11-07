# Shift Memory console — design system

Written at finish of the first build (2026-11-07). World: night-shift control room. Mode: Operate.
Tokens live in `src/styles.css` `:root`; this file explains them.

## Palette
| Role | Token | Value |
|---|---|---|
| Ground | `--ground` | `#0c1017` |
| Rail / header | `--rail` | `#111a24` |
| Panel | `--panel` | `#0f1620` |
| Hairline | `--line` / `--line-soft` | `#223042` / `#182434` |
| Ink | `--ink` / `--ink-2` / `--ink-3` | `#e8edf3` / `#aab6c5` / `#74839a` |
| Wearer series (fixed order) | `WEARER_COLORS` in `store.ts` | `#3987e5` `#d95926` `#199e70` `#c98500` `#d55181` `#9085e9` |
| Places | `--place` | `#199e70` |
| Entities / assets | `--entity` | `#9085e9` |
| Status (reserved, never themed) | `--critical` `--warning` `--good` | `#d03b3b` `#fab219` `#0ca30c` |
| Focus ring | `--focus` | `#7fb4ff` |

Series and status values come from the validated dark palette in the dataviz skill. Wearer
color follows the wearer, never their rank in the list; status colors always ship with an icon
and a word.

## Type
Inter Tight 400–700 for UI; JetBrains Mono 400–500 for IDs, times, readings, and chips.
Body 13px in panels, 15px nowhere yet (the drawer uses 13px with a larger photo instead).
Tabular numerals on by default.

## Density and spacing
Three columns 360 / fluid / 360 at 1440; 36px column heads; 6px list gutters; 8px card
padding; hairline separators, no card borders unless selected.

## Signature move
The floor schematic (`src/floor.ts`): places as zones, assets as fixed monospace tiles,
events as 5px marks on a vertical time axis under the asset they touched, the operator's
NEXT path as a faint bezier, CHANGES as amber ticks, alerts as a red halo on the mark and a
red tile border on the asset.

## Motion
One authored moment: a new event slides in and its mark's halo breathes once. The drawer
slides 16px. Nothing else moves.

## States
Connection dot: amber connecting, green live, red error. Event status chips: accepted
(amber), in_graph (green), failed (red). Empty states are sentences, not icons.

## Browser surfaces
Selection, caret, focus ring, and scrollbars are themed from the palette.
