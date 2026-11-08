# manifest.json

```jsonc
{
  "tz": "-06:00",
  "wearers": [{ "deviceId": "edward-iphone", "name": "Edward", "role": "Builder", "shift": "Night" }],
  "shifts": [
    // consecutive stints; the console draws a handoff card between them
    { "shiftId": "wk-sat-am", "deviceId": "edward-iphone", "start": "2026-11-07T08:00:00-06:00", "end": "2026-11-07T13:00:00-06:00", "title": "Saturday morning" }
  ],
  "events": [{
    "id": "wk-0001",                       // stable; becomes event_id
    "deviceId": "edward-iphone",
    "t": "2026-11-07T08:12:51-06:00",      // capture time
    "source": "shutter_button",            // shutter_button | sdk_capture | camera_roll | manual_upload
    "photo": "photos/photo-75.jpg",        // relative to demo/weekend; or "module:<event_id>" for a photo already in wm-physical (fetched from the module snapshot)
    "keepFaces": "all" | "none" | [[x,y,w,h], ...],  // normalised rects (origin top-left) of faces NOT to blur; default "none"
    "lat": 32.98612, "lon": -96.75125, "accuracyM": 12, "floor": 0,
    "place": "Axxess Atrium",              // becomes a place entity + INVOLVES(setting) edge
    "summary": "…",                        // one sentence in perceive's register
    "activity": "checking in",
    "people": 3,
    "textInScene": ["HACKUTD 2026"],
    "note": "optional spoken/typed note",
    "label": "optional label",
    "dwellMin": 25,                         // how long the wearer stayed around here after the photo (track synthesis)
    "wander": 40,                           // optional metres of indoor wandering during a long dwell
    "live": false                           // true = this row also exists in wm-physical under the same id (overlay keeps the live row, adds the photo/location if missing)
  }],
  "issues": [{
    "id": "wk-issue-token", "title": "First real photo blocked on the ingest token", "asset": "capture app",
    "kind": "fault_text",                  // fault_text | anomaly | state_change (console colour: red while open)
    "raisedBy": "wk-0012", "resolvedBy": "wk-0014", "how": "photo_shows_recovery", "note": "optional resolution note"
  }],
  "hideLive": ["96d4000f-d34b-4d62-a80e-bf588ae94c29"],  // wm-physical events the weekend workspace does not show (test shots)
  "badgeAfter": "2026-11-08T12:00:00-06:00",             // optional: live photos with people, taken after this (and after the record), get the workspace badge; default = the record's end
  "waypointFiles": ["module-waypoints.json"],            // arrays of {t, lat, lon, floor?, accuracyM?, real?} merged into the track waypoints (the phone's real fixes)
  "extraWaypoints": [{ "t": "…", "lat": 0, "lon": 0, "floor": 0, "dwellMin": 0 }]  // places walked through without a photo
}
```

`build.mjs` output `web/public/weekend/weekend.json`, store-ready (micros as decimal strings):

```jsonc
{
  "generatedAt": "ISO", "staticEnd": "ISO",
  "wearers": [...], 
  "events": [{ "eventId", "deviceId", "clientT", "tMicros", "source", "status": "in_graph", "note", "label", "scene", "locationGuess", "activity", "summary", "peopleCount", "confidence": 0.9, "perceptionJson": "{\"text_in_scene\":[…]}" }],
  "locations": [{ "eventId", "deviceId", "shiftId", "tMicros", "lat", "lon", "accuracyM", "floor", "fixT" }],
  "track": [{ "pointId": "wk-t-000001", "deviceId", "shiftId", "tMicros", "t", "kind": "point|shift_start|shift_end", "lat", "lon", "accuracyM", "floor" }],
  "entities": [{ "entityId", "canonicalName", "kind": "place", "aliases": [], "firstSeenMicros", "lastSeenMicros" }],
  "edges": [{ "edgeId", "fromId", "toId", "kind": "INVOLVES|NEXT", "props": "{\"role\":\"setting\"}" }],
  "alerts": [{ "id", "alertId", "eventId", "kind", "rawKind", "text", "tMicros", "assetName", "deviceId", "wearerName", "acked", "ackedMicros", "slackStatus": "weekend" }],
  "resolutions": [{ "id", "alertId", "eventId", "deviceId", "tMicros", "how" }],
  "photos": { "<eventId>": "photos/<eventId>.jpg" },
  "thumbs": { "<eventId>": "photos/<eventId>.thumb.jpg" },
  "hideLive": [...]
}
```
