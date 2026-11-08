# 0033 the weekend workspace: the team's own weekend as an overlay, and the judging beat

- Date: 2026-11-08
- Status: active (extends 0029, 0031; demo only)
- Source: Edward, chat; built by Edward's agent (issue #29, branch `web/29-weekend`)

**Decision.** The console gets one more workspace, **HackUTD 2026 · this weekend**: the live capture
database (`wm-physical`) with a curated static overlay laid over it. The overlay is the team's own
weekend at UT Dallas as the memory would have recorded it: the photos Edward took on the Ray-Ban
Meta glasses from Saturday morning on (from the Meta AI app via the camera roll, and the ones the
capture app already uploaded), the phone's real track where it exists and a reconstructed walk
over the campus path network where it does not, the problems we hit (from the `#log` record) raised
and resolved where they happened, and five "shifts" with handoffs between them. It replays on the
campus model at up to 3600× so a day and a half fits in a minute. It is a demo device and says so
in its subtitle; it is not how a customer uses the product.

**The judging beat.** At the start of the talk a photo of the judges is taken on the glasses and
goes through the real pipeline (face blur on the phone, `ingest_photo`, perception). While the
overlay is active, live photos older than the record are replaced by the overlay's copies and
later ones show on top of it; a later live photo with people in it gets the workspace's badge,
*Judged by another amazing judge*, on its pin, in the feed, the timeline and the detail panel, with
a toast on the map. A later photo without people (the fault panel, the live beat) is not badged.
`badgeAfter` in the manifest moves the badge threshold to the demo slot so photos taken earlier
that day stay plain.

**Mechanics (all additive).** `workspaces.ts` entries may carry `overlay` (a store-ready JSON built
by `demo/weekend/src/build.mjs`), `tag`, `allShifts`, `campus`, `tileRadius`, `badge`; several
workspaces may share a database, chosen by id (`?ws=weekend`). `store.ts` exposes an overlay hook
and filters live rows against the active overlay; `overlay.ts` applies the JSON as if it were a
subscription. The brain panel and the replay cover the whole record when an overlay is active.
The map draws the wider campus (`web/src/site3d/data/campus.json`, OSM) when asked. Nothing shows
unless the workspace is chosen; the other workspaces are untouched.

**Privacy.** Every photo in the overlay goes through Apple Vision face blur before it is published;
only the team's own faces are kept, per photo, in the manifest (`keepFaces`). Published photos
carry no EXIF or GPS. Positions come from the phone's fixes where the module has them and from the
Photos library otherwise; the walk between photos is reconstructed and labelled as such.

**Reason.** Judges meet the product as a data center tool; showing the same memory holding the
weekend they are sitting in, and then themselves in it a minute after being photographed, makes
"operational memory for physical work" concrete and personal in thirty seconds, without touching
the backend or the live demo path.
