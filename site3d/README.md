# Reflection · Site (`site3d/`)

The site view: a 3D model of the building the shift happens in, each wearer as a lit dot with a
fading trail and a heat layer where they lingered, photo pins where photos were taken, and the
shift's memory beside it (who is on the floor and where, what needs attention, the handoff between
shifts with what was carried over, and what happened in order). Live, or replayed at 1–300× with a
scrubber. Issue #24.

```sh
cd site3d && npm install && npm run dev      # http://localhost:5174
npm run build                                # static bundle in dist/
```

- Data: the live tables over the Spacetime HTTP SQL endpoint, polled every 4 s (`src/store.ts`).
  Follows `demo_config.active_dataset` on `wm-physical` like the console (decision 0029); `?db=wm-physical`
  pins the real capture. Nothing is written.
- Building: ECSW (UT Dallas) from OpenStreetMap, relation 8384532: the 4-level footprint with its
  courtyard, the mapped ground-floor rooms (Axxess Atrium, Freshman Design, Wood Shop, labs,
  classrooms), neighbouring buildings and campus paths, in `src/data/ecsw.json` (ODbL). Ground is
  Esri World Imagery at zoom 19. A dataset whose walk is not at ECSW gets imagery at its own
  centroid and a translucent hall around the walk.
- Position: `track_point` smoothed with a 5-point moving average, interpolated between fixes; a
  wearer disappears 10 minutes after their last fix or at `shift_end`. The room under the dot comes
  from the OSM room polygons. Indoor GPS here measured 2–50 m (median 8–22 m), so the dot reads at
  building scale (decision 0028). `floor` is honoured when the phone sends it; the phone does not yet.
- Keys: space play/pause · L live · F follow · 2 / 3 view.
