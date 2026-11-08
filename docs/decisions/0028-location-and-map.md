# 0028 location on every photo, a shift track, and the map as the console's canvas

- Date: 2026-11-08
- Status: active (extends 0026; contract v3.1). The map is now the 3D site (#24, #26); sample workspaces get generated sites (0032)
- Source: Edward (phone side, `#log` decision 2026-11-07 19:40), Gary (console direction, chat)

**Decision.** The phone supplies location: a Core Location fix on every photo and a continuous
walking track for each shift (a point every 5 m or 30 s, phone locked included, accuracy ≤ 50 m),
batched to the module every 30 s. The module stores the fix in `event_location` and the track in
`track_point` through `ingest_track` (issue #20, published 2026-11-08). The console's primary view
is the site map (issue #21): each wearer's track in their color, photo pins with the thumbnail,
open alerts burning red and settling when acknowledged, pins clustered when they fall within
accuracy of each other. The relationship graph stays as the lens: a cluster or the "photos without
a position" pill opens it scoped to those photos, and a Graph switch shows it full width. Replay
drives both. The computer is the front end; the phone is the middle man.

**Reason.** A map needs no vocabulary from a first-time viewer; where people walked, where
photos were taken and where the problems are is the physical-world claim made literal. The graph
on its own showed structure but asked the viewer to learn it. Known limit: indoor GPS is 10–50 m,
so the map reads at building and site scale, not room scale; tracks are smoothed, loose fixes
drawn with an accuracy ring, and a cluster hands over to the graph for what connects.

**Dependency.** Leaflet 1.9.4 in `web/`, with Esri World Topographic tiles (no key, attribution
shown). If tiles cannot load, tracks and pins still draw on a blank canvas.
