# The weekend workspace (`HackUTD 2026`)

A static dataset for the console's "HackUTD 2026" workspace: the team's own weekend at UT Dallas,
replayed through the same console that shows a data center shift. It is a demo device, not a
customer workflow. Built from the photos Edward took on the Ray-Ban Meta glasses (Meta AI app →
camera roll → Photos) plus the photos the capture app already uploaded to `wm-physical`.

Pipeline (`src/`):

- `manifest.json` — the curated story: wearers, shifts, every photo with time, place, position,
  floor, caption (written the way `perceive` writes them), notes, and the issues raised/resolved.
- `src/track.mjs` — synthesises a plausible walking track between the photo positions over the
  campus path network (`osm-utd.json`, OpenStreetMap, ODbL): `node src/track.mjs waypoints.json > track.json`.
- `src/blur.swift` — face blur (Apple Vision), run on every photo before it is published; faces
  listed in the manifest's `keepFaces` are left alone (the team's own).
- `src/build.mjs` — reads the manifest, blurs/resizes photos, calls `track.mjs`, and writes
  `web/public/weekend/weekend.json` + `web/public/weekend/photos/`.

Run: `node demo/weekend/src/build.mjs` from the repo root, then `cd web && npm run build`.

The track is the phone's real fixes wherever the capture app was tracking (Saturday 20:13 to
Sunday 04:45); photos taken inside that coverage are pinned on the real track at their capture time.
Everything else is reconstructed: the walk between photo positions is routed over the campus path
network, and `extraWaypoints` in the manifest is an invented but plausible itinerary (breakfast and
lunch at the Student Union, air breaks on the lawn, snack runs to the atrium, the level-4 team room)
so the day reads the way it was lived. Shared photos arrived without EXIF, so their times were set by
hand against the Photos library's timestamps and GPS. The workspace subtitle and decision 0033 say so.

## The demo beat (for `demo/DEMO_SCRIPT.md`, issue #29)

**Before the talk (T-60).** Rebuild the overlay with the latest photos and the demo slot as the badge
threshold: set `badgeAfter` in `manifest.json` to ten minutes before the slot, run
`node demo/weekend/src/build.mjs`, then `cd web && npm run build`, commit, push to `main`; Vercel
redeploys reflection.vercel.app. (Without the rebuild everything still works; photos taken earlier
that day would just get the badge too.) On the projector laptop open
`https://reflection.vercel.app/?ws=weekend` once (the choice is remembered in that browser;
"Follow server default" in the switcher undoes it), press **Map**, confirm the campus loads and
Replay at 3600× runs through the weekend. Switch back to the data center workspace for beat 1.

**Beat 0 — the photo (Edward, 0:00, during Gary's first sentence).** Glasses on, phone in the
foreground, one shutter press framed on the judges' table from where you stand. Say nothing about
it. The photo goes through the real path: faces blurred on the phone, `ingest_photo`, Nemotron reads
it, `in_graph` in about ten seconds.

**Beat 1½ — the reveal (Gary, about a minute in, 0:30).** Open the switcher, pick **HackUTD 2026**.
"The same memory has been running on us all weekend." Press **Replay** at 3600×: the dot walks the
campus, problems light up red and go green where we fixed them, the handoffs between our own shifts
carry the open ones. When the replay reaches now, the newest pin on the map is the photo from a
minute ago with its label, **Judged by another amazing judge**; the feed and the timeline show the
same line. "And as of a minute ago, so are you. Faces blurred on the glasses before it left the
phone." Switch back to the data center workspace and continue.

**Expect.** The badge appears when perception lands (it needs the people count), so give the photo
a minute. A later photo without people (the fault panel, the live beat) stays unbadged. If the venue
Wi-Fi drops, the overlay is static and still plays; only the judges' photo depends on the live path.

**If it fails.** No judges' photo after two minutes: play the replay anyway, "the photo of you is on
its way through the pipeline"; it lands whenever it lands and the toast announces it. Landed without
a badge: the model counted zero people; open the card from the timeline and read its summary.
