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

The track between photos is reconstructed from photo times and positions and says so in the
workspace subtitle; photo positions are the phone's fixes where the module has them and the
Photos-library GPS otherwise.
