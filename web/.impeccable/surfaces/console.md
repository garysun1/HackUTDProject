# Surface brief: operations console (`web/`)

Scope: the single-page console at `web/index.html`. Visitor mode: **Operate**.
Audience: shift leads and supervisors; judges on a projector. Job: see the floor's state,
act on alerts, read the handoff, ask a question. Primary task: read an alert and reach its
photo in one click. Constraints: dark room, two-meter viewing distance, live data.

## Direction contract

THESIS: The floor is the layout. The console refuses the category default of a KPI row
over a table and instead draws the entity graph as a floor schematic: places as zones,
assets as fixed tiles, events as time-ordered marks attached to the asset they touched.
Everything else (timeline, alerts, handoff, ask) is a lens on that same graph.

OWN-WORLD: Night-shift control room. Ground `#0c1017`, tinted ink rail `#111a24`, hairline
`#223042`. Type: Inter Tight for UI, JetBrains Mono for IDs, times, and readings. Series
colors from the validated dark categorical palette (blue `#3987e5` wearer 1, orange
`#d95926` wearer 2, aqua `#199e70` places, violet `#9085e9` entities). Status fixed:
critical `#d03b3b`, warning `#fab219`, good `#0ca30c`, each with an icon and a label.
Density high; 13px body in panels, 15px in the detail drawer.

STORY: A supervisor who was not on the floor opens the console and understands in ten
seconds what needs attention, what changed, and who was where, then clicks any line and sees
the photo that proves it.

FIRST VIEWPORT: Top bar 44px: product name, database and connection state, shift window
selector, wearer chips. Left column 360px: event timeline, newest first, thumbnail,
time, wearer, summary, status chip. Center: the floor schematic canvas; zones as labeled
columns, asset tiles with last reading, event marks on a vertical time axis under each
asset, NEXT edges faint, CHANGES edges amber, alerts pulsing on their asset. Right rail
360px: Alerts (acknowledge), Handoff (window, Generate, sections with citations), Ask
(input, cited answer). Clicking an event anywhere opens a detail drawer over the right rail
with the full photo, perception fields, and wearer.

FORM: Operate shell, code-led, first on the ordered list. seed: none (unavailable).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review,
the verdict, DESIGN.md, and every shipping raster carrying its provenance.
