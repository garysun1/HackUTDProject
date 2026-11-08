# 0030 the shift view: chronological order is canonical, four kinds of thing on screen

- Date: 2026-11-08
- Status: active (supersedes the force graph of 0028's "lens"; the map of 0028 stays)
- Source: Gary, chat

**Decision.** The console's primary view is the shift line. Photos sit on one horizontal line in
time order with the time and wearer beneath; that order is the canonical structure and nothing
else lays anything out. Four kinds of thing appear: photo, equipment, issue, note. Equipment
(registry assets and whatever the wearer labelled) and issues (alert rows, red while open, a
check once acknowledged) hang above the line and thread down to every photo they appear in;
notes (what the wearer typed or said) hang below their photo. A change arcs from the earlier
photo of a piece of equipment to the later one with its text. Shared identifiers read in the
scene (ticket numbers, asset tags) and look-alike photos appear only while a photo is hovered.
Everything that is only about one photo, place included, lives behind the click in the detail
panel. Labels are plain words from the registry ("PDU A (Rack R12)", "cooling unit", "battery
backup"); codes are secondary and appear on hover. The map remains the second view for where.

**Reason.** The force graph showed structure for its own sake: six node and edge types, a layout
that moved, labels that drifted, and place names the model spelled three ways becoming three
hubs. A first-time viewer had to learn it before reading it. A line in time order needs no
vocabulary, every mark is aligned so nothing collides, and the two things the demo must land,
the problem and the change, are a red pill and an amber arc with their text printed once.

**Later.** Question nodes for MCP queries (which photos answered a judge's question) need a small
table in the module and are the natural next addition to this view.
