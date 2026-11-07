# Shift Memory (capture-app)

iOS app for the capture side of *Working Memory for the Physical World*. It receives standalone
photos from Meta Ray-Ban glasses (Meta Wearables Device Access Toolkit 1.0.1), blurs faces, resizes
to a 1600 px long edge JPEG, and posts each one straight to the SpacetimeDB module as one event
(`ingest_photo`, see `docs/CONTRACT.md`). Every photo then shows up in the web console, the MCP
tools and the alerts Gary built.

Owner: Edward. Issues: #1 (capture), #2 (camera-roll fallback), #10 (real-glasses measurements).

## What it does

| Path | Source | How |
|---|---|---|
| Capture button in the app | `sdk_capture` | `capturePhoto(resolution:quality:)` on the camera's Photo child; one in flight, 40 s timeout |
| Glasses shutter button | `shutter_button` | Same `photoDataPublisher`, delivered while the app holds a session |
| Camera-roll import (off by default) | `camera_roll` | PhotoKit change observer; new glasses photos uploaded with their original creation time |
| Share-sheet / picker upload | `manual_upload` | PhotosPicker on the home menu |

All four go through `ImagePipeline` (decode, EXIF time, downsample, Vision face pixellation, metadata-free
JPEG, thumbnail) → `CaptureCoordinator` → `EventStore` (on-phone history) + `UploadQueue` (disk-backed,
bounded, retries with backoff, idempotent on `event_id`) → `IngestClient` (`POST /v1/database/wm-physical/call/ingest_photo`
with `["<event_json>", "<jpeg_base64>"]`). After `accepted` the queue polls
`SELECT status, summary FROM event WHERE event_id = …` until the module has read the photo (`in_graph`).

## Layout

```
ShiftMemory/
  App/        ShiftMemoryApp (entry, Meta AI callback URL), AppModel (composition root)
  Capture/    GlassesController (DAT session/camera/photo, shutter vs app capture), CaptureCoordinator
  Pipeline/   ImagePipeline + contracts
  Upload/     CaptureEvent, EventEnvelope (event_json), IngestClient, UploadQueue, EventStore
  Import/     CameraRollImporter (#2)
  Diagnostics/DiagnosticsStore (#10 measurements, CSV export)
  Config/     AppConfig (UserDefaults), Keychain (ingest token), Config.example.plist
  UI/         RootView (home), EventDetailView, SettingsView, DiagnosticsView, DebugMenuView (DEBUG), Theme
ShiftMemoryTests/   XCTest unit tests
Tools/typecheck.sh  fast swiftc type-check without Xcode
MEASUREMENTS.md     the real-glasses protocol for #10
```

## Build and run

Requirements: Xcode 26.4+, iOS 17.2+ device or simulator. Packages resolve from
`github.com/facebook/meta-wearables-dat-ios` (exact 1.0.1).

```sh
cd capture-app
xcodebuild -project ShiftMemory.xcodeproj -scheme ShiftMemory \
  -destination 'platform=iOS Simulator,name=iPhone 17' -derivedDataPath /tmp/sm-dd build
xcodebuild ... test        # unit tests
Tools/typecheck.sh ShiftMemory/Upload/UploadQueue.swift   # single-file type check
```

Config: Settings → Backend. Defaults are `https://maincloud.spacetimedb.com` / `wm-physical`.
Paste the ingest token there (Keychain) or drop a `Config.plist` next to `Config.example.plist`
(never commit it). Without a token the module answers `invalid_token` and the event shows as failed
with that message; set the token and tap Retry.

### Simulator without glasses (DEBUG)

Launch with `-mockGlasses` (or toggle it in the ⋯ menu → Mock glasses… and relaunch). Then:
Mock glasses… → Pair Ray-Ban Meta → Power on · unfold · don → close → **Start shift** → **Capture**
(or "Simulate shutter press" to exercise the `shutter_button` path). A synthetic rack fixture is
used as the photo. With a valid token the event goes queued → uploading → accepted → in graph.

### Real glasses

1. Pair the glasses in the Meta AI app. 2. Shift Memory → Connect to Meta AI (one-time registration,
camera permission). 3. Start shift. 4. Press the shutter or tap Capture. Device id (Settings → Identity)
goes to Gary for `demo/wearers.csv`. Follow `MEASUREMENTS.md` for #10 and report in `#log`.

## Privacy

Faces are pixellated on the phone before any byte leaves it (Vision `VNDetectFaceRectanglesRequest`);
EXIF/GPS is stripped. People are counted, never identified. The ingest token lives in the Keychain.
