# Handoff: Shift Memory capture app — current state (2026-11-07 ~18:00 CST)

> Latest section first. The original 17:00 handoff that the previous agent wrote follows below and is
> still accurate for rules/decisions; everything in its "remaining work" list has since been done
> except the hardware steps, which are the blocker described here.

## Where things stand (Devin, Edward's agent, 15:00–18:00 CST)
All code for #1/#2/#10 and the #11 drafts is on branch `capture/1-photo-button`, pushed, draft
[PR #18](https://github.com/garysun1/HackUTDProject/pull/18) description is current. Commits
`1f3ad54 … 5db8da0`. Nothing is uncommitted. (Edward's Mac has `git stash@{0}` with the old
untracked workflow files — identical to what is committed; safe to `git stash drop`.)

- Simulator build + `xcodebuild test` green: **32/32 unit tests** (CameraRollImporter, DiagnosticsStore, IngestClient).
- Signed **device build installed and running on Edward's iPhone 17** (UDID `00008150-00020DD43E40C01C`,
  team `GBYFS3GAPJ`, Xcode 27.2 on the Mac, derived data `/tmp/sm-dev`). Install/launch commands:
  ```sh
  cd ~/HackUTDProject/capture-app
  xcodebuild -project ShiftMemory.xcodeproj -scheme ShiftMemory -destination 'id=00008150-00020DD43E40C01C' \
    -derivedDataPath /tmp/sm-dev -allowProvisioningUpdates build
  xcrun devicectl device install app --device 00008150-00020DD43E40C01C /tmp/sm-dev/Build/Products/Debug-iphoneos/ShiftMemory.app
  xcrun devicectl device process launch --terminate-existing --device 00008150-00020DD43E40C01C com.edwardkim.hackutd.shiftmemory
  ```
  The phone must be on USB-C (a data cable; Wi-Fi debugging is not enabled and the campus network blocks Bonjour).
- Verified against the live module from the client: `ping` 200, `sql` 200, `ingest_photo` with a bogus token → `invalid_token`.
- Slack: reply posted in Gary's #general thread (ts `1794094460.509159`, parent `1794092446.681629`) answering his
  4 questions. Not yet posted: `[DONE]` in `#log` (only after a real photo reaches `in_graph`), the device id
  for `demo/wearers.csv`, and the #10 backgrounded-shutter answer.

## Contract findings (already handled in `IngestClient`, flagged to Gary; CONTRACT.md not edited — Gary's file)
- The HTTP `/call` endpoint returns a procedure's result as a **positional JSON array**, not an object:
  `ping` → `["2026-11-07T23:27:32.279Z","1794094052279619"]`, so `ingest_photo` → `[eventId, serverT, status]`.
  `IngestClient.jsonObject(_:positional:)` zips arrays onto the module's field order and still accepts objects.
- `SenderError('invalid_token')` surfaces as **HTTP 500** with body
  `The module instance encountered a fatal error: invalid_token` (same for `missing_*`, `invalid_event_json`,
  `missing_photo`). `IngestClient.failure(status:body:)` classifies by body text, not status. The older note
  below saying "HTTP 4xx" is wrong.

## CURRENT BLOCKER — "Capture setup failed" on real glasses
Edward tapped **Start shift** on the phone with his Ray-Ban Meta glasses and got the error
**"Capture setup failed"**. That string is the DAT SDK's localized description of
`PhotoError.sessionSetupFailed(underlying:)` (`MWDATCamera/en.lproj/CameraErrors.strings`,
`dat_error_capture_setup_failed`), documented as "The session could not be started due to a transport setup
failure" / Android: "the glasses did not activate the capability". So: the DAT **device session started**
(we got past `waitForSessionStarted`), the camera was added, but the standalone **Photo child** did not reach
`.started` — `GlassesController.startPhotoChild()` already retries once with a fresh `Camera`, so it failed twice.

Relevant code: `ShiftMemory/Capture/GlassesController.swift` — `startShift()`, `startPhotoChild()`,
`photoError(_:)` (the `.sessionSetupFailed` branch), `waitForPhotoStarted`. The error text reaches the UI via
`lastError`; the raw `underlying` error is currently **not logged** — first thing to add is
`NSLog("[Glasses] photo error: \(error) underlying: \(String(describing: underlying))")` in `photoError` and in
the photo-state listener, rebuild, reinstall, reproduce.

Things we do **not** know yet (check in this order):
1. Is the glasses' camera permission actually granted for Shift Memory in the Meta AI app?
   `ensureCameraPermission()` passed, but confirm in Meta AI → Devices → (glasses) → connected apps.
   Permission denial normally surfaces as `.permissionDenied`, not setup-failed, but verify.
2. Was the Meta AI app (or another DAT app) holding a stream/photo session at the same time? Stream and Photo
   compete for the camera; the toolkit does not arbitrate. Force-quit Meta AI, retry.
3. Glasses state: on the face / unfolded, awake, battery not critical (`.deviceHealthCritical` would be its own
   case, but low battery can make setup flaky), firmware up to date (Meta AI → Devices → update). Also
   `needsGlassesAppUpdate` / `.datAppOnTheGlassesUpdateRequired` is handled on `session.start()` only — check
   whether a glasses-side update prompt appears in Meta AI.
4. Standalone photo capture is **beta / dev-channel only** in DAT 1.0 ("Dev and beta only" on the PhotoError
   page). Confirm Edward's Meta developer account has the glasses enrolled in the developer/beta channel and that
   the app is registered in the Meta Wearables developer portal with the camera capability
   (`Wearables.configure()` succeeded, Info.plist has the `MWDAT*` keys — see `ShiftMemory/Info.plist`).
5. Timing: `waitForPhotoStarted` gives 20 s. Check the state listener actually sees `.starting`; if the state
   stream never fires, suspect the listener-before-start ordering or that `camera.photo` must be started only
   after the camera itself reports ready (re-read the iOS "camera-capture" guide:
   https://wearables.developer.meta.com/docs/develop/dat/camera-capture/ and the `Photo` / `PhotoError` reference).
6. Fallback if photo-child startup cannot be fixed quickly: the glasses' own shutter photos land in the Meta AI
   app → iOS camera roll. `CameraRollImporter` (#2) is built: Settings → Camera roll import → on → **Scan now**
   uploads them as `camera_roll` events with their original timestamps. That unblocks Gary's demo even without
   the live session. Edward has already shot many photos with the glasses this way.

Logs: the Mac may still be running two background tails started by Devin —
`idevicesyslog -u 00008150-…` → `/tmp/sm-syslog.log` (whole phone syslog; grep `ShiftMemory|MWDAT|dat_error`)
and `xcrun devicectl … launch --console` → `/tmp/sm-console.log` (stdout only; was empty). `pkill -f idevicesyslog`
when done. `NSLog` output appears in the syslog, not the console file.

## Remaining after the blocker
- First real photo → `in_graph` → post `[DONE] (Claude) #1 …` top-level in `#log` and the device id
  (Settings → Identity → Copy) in Gary's #general thread for `demo/wearers.csv`.
- Paste Gary's `INGEST_TOKEN` in Settings → Backend → Test connection (Keychain; never commit it, never paste it in
  Slack or git). Until then every upload shows `failed: invalid_token` and retries after the token is set.
- Run `capture-app/MEASUREMENTS.md` (#10): backgrounded-shutter delivery first — it decides whether #2 stays on
  by default. Report in `#log`.
- Mark PR #18 ready for review when a real photo has gone through.

---

# Handoff: finish the Shift Memory capture app (issues #1, #2, #10, #11)

Paste this file's contents (or "read capture-app/HANDOFF.md and continue") into a fresh Claude Code
session started in `~/HackUTDProject` on branch `capture/1-photo-button`. Written 2026-11-07 ~17:00 CST
by Edward's previous agent session when its usage ran out.

## Who you are and the rules
You are Edward Kim's coding agent on the HackUTD 2026 team repo github.com/garysun1/HackUTDProject
("Working Memory for the Physical World"). Edward owns capture + the iOS app; Gary owns `module/`, `web/`,
`docs/`. Read `CLAUDE.md`, `docs/DESIGN.md` §4/§10, `docs/CONTRACT.md`, the Slack `#log` channel
(id `C0CFWBVEE9J`), and this file before writing code. Rules Edward set this session:
- **Ask Edward before any executive decision not already laid out** (below or in the docs). Routine
  implementation choices inside the capture app are yours.
- Never guess Meta SDK API names. Ground truth is the SDK's public swiftinterface: in a scratch dir
  `git clone --depth 1 https://github.com/facebook/meta-wearables-dat-ios && git fetch --depth 1 origin tag 1.0.1`,
  then `git show 1.0.1:MWDATCamera.xcframework/ios-arm64/MWDATCamera.framework/Modules/MWDATCamera.swiftmodule/arm64-apple-ios.swiftinterface`
  (same for MWDATCore, MWDATMockDevice). The main branch has no Package.swift; tags do.
- Never commit secrets. `Config.plist` is gitignored; the ingest token lives in the Keychain.
- Don't touch `module/`, `web/`, `docs/`, or `CONTRACT.md`. Post `[DONE] (Claude) …` in `#log` from Edward's
  Slack account when a piece is verifiably done (details in a thread), update the draft PR, close issues via the PR.

## Decisions already made with Edward (do not re-ask)
- Fresh SwiftUI app **"Shift Memory"** in `capture-app/`, bundle `com.edwardkim.hackutd.shiftmemory`, URL scheme
  `shiftmemory://`, team `GBYFS3GAPJ`, iOS 17.2+, Swift 6 strict + Approachable Concurrency, DAT **1.0.1** via SPM.
- Scope: #1 capture app; #2 camera-roll import behind a Settings toggle; #10 instrumentation (Diagnostics screen +
  `capture-app/MEASUREMENTS.md`, Edward runs the hardware tests); #11 drafts `demo/DEMO_SCRIPT.md`, `demo/REHEARSAL.md`,
  `demo/SUBMISSION.md` marked DRAFT for Gary.
- Delivery: branch `capture/1-photo-button` → draft PR to `main` (already open; update it, mark ready when green).
- Comms: issues #1 #2 #10 #11 are assigned to eedwardkim; `[CLAIMED]` was posted in `#log`
  (message ts `1794090783.805329`; reply in that thread for progress, top-level only for `[DONE]`/`[BLOCKED]`).

## Backend facts you will code against (verified in module/spacetimedb/src/index.ts)
- DB `wm-physical` on Maincloud. `POST https://maincloud.spacetimedb.com/v1/database/wm-physical/call/ingest_photo`
  with body `["<event_json>", "<photo_b64>"]`; reply **camelCase** `{eventId, serverT, status}` (contract doc shows
  snake_case; accept both). Statuses: `accepted | in_graph | failed | duplicate` (no `perceived` step exists).
  Validation errors are `SenderError('invalid_token' | 'missing_<field>' | 'invalid_event_json' | 'missing_photo')`
  → HTTP 4xx with the message in the body. `ping` → `{serverT, tMicros}`. Reducers `set_label`/`set_note` take
  `["<event_id>", "<value>"]`. Status poll: `POST …/sql` (text/plain) `SELECT status, summary FROM event WHERE event_id = '…'`
  → `[{schema, rows: [[status, summary]]}]`. The ingest token comes privately from Gary (asked in #log).

## State of the code (all on the branch)
Builds green on the iOS Simulator as of the last commit? **Only the scaffold did** (`ShiftMemoryApp`, placeholders,
contracts). Since then real files were added without an integrated build. Run the build first (commands below).
- `capture-app/ShiftMemory.xcodeproj` — hand-written, objectVersion 77, synced folders `ShiftMemory/` and
  `ShiftMemoryTests/`, Info.plist exception set, DAT package exactVersion 1.0.1 (MWDATCore, MWDATCamera, MWDATMockDevice
  on both targets), shared scheme. `ShiftMemory/Info.plist` has the MWDAT dict, URL type, background modes,
  external-accessory protocol, Bonjour, usage strings, analytics/crash opt-out. Entitlements: Hotspot + wifi-info.
- Contracts (compiled by every module): `Upload/CaptureEvent.swift` (CaptureSource, EventStage, CaptureEvent),
  `Upload/EventEnvelope.swift` (exact `event_json` builder), `Upload/IngestContracts.swift` (IngestClientProtocol with
  ping/ingest/status/setLabel/setNote, IngestError + isRetryable, BackendEndpoint), `Pipeline/PipelineContracts.swift`
  (ImagePipelineProtocol, PreparedPhoto, ImageFormat.sniff), `Diagnostics/DiagnosticsModels.swift`,
  `Import/ImportContracts.swift`, `UI/Theme.swift` (tokens mirrored from web/src/styles.css + Surface/PanelHead/StatusPill/InkButtonStyle).
- Done and typechecked: `Config/AppConfig.swift`, `Config/Keychain.swift`, `Capture/GlassesController.swift`
  (registration, permission, session, camera.photo start with one retry, capture with 40 s timeout, shutter-vs-app
  tagging, DEBUG `debugSimulateShutterPress()`, lifecycle events).
- Written, NOT yet compiled (depend on the modules below): `Upload/EventStore.swift`, `Capture/CaptureCoordinator.swift`,
  `App/AppModel.swift`. `UI/RootView.swift` is a placeholder.
- A background Workflow (`shift-memory-modules`) was implementing, reviewing and fixing in parallel:
  `Pipeline/ImagePipeline.swift`, `Upload/IngestClient.swift`, `Upload/UploadQueue.swift`, `Import/CameraRollImporter.swift`,
  `Diagnostics/DiagnosticsStore.swift`, `capture-app/MEASUREMENTS.md`, `demo/DEMO_SCRIPT.md`, `demo/REHEARSAL.md`,
  `demo/SUBMISSION.md`, plus tests in `ShiftMemoryTests/`. It may have finished after the last commit: run `git status`
  and read whatever landed; verify each file against its brief in the workflow script
  `~/.claude/projects/-Users-edwardkim/5786fb63-d1e9-4be3-a020-f550e1f2858e/workflows/scripts/shift-memory-modules-wf_15df67db-291.js`
  (the briefs there are the spec for each module's public API, which AppModel/CaptureCoordinator already call).
  If a file is missing or partial, implement it to that brief.

APIs AppModel/CaptureCoordinator expect (match these or adjust the callers):
`ImagePipeline()` + `@concurrent prepare(_:options:) async throws(PipelineError) -> PreparedPhoto`;
`IngestClient(endpoint: @Sendable () -> BackendEndpoint)`; `actor UploadQueue(client:directory:configuration:)` with
`Configuration{ingestToken, appVersion}`, `nonisolated let updates: AsyncStream<Update>`, `Update = .stage(eventId:stage:serverT:error:attempts:) | .polled(eventId:status:summary:) | .depth(pending:)`,
`enqueue(_:jpeg:)`, `start()`, `kick()`, `startPolling(eventId:)`; `CameraRollImporter()` with `onlyGlassesPhotos`, `onPhoto`,
`isEnabled`, `setEnabled(_:) async`, `scanNow() async`; `DiagnosticsStore(directory:)` with `begin(id:source:)`, `update(id:_:)`,
`rename(id:to:)`, `recordBattery(glasses:phone:)`, `noteSessionStart(success:ms:error:)`, `notePhotoStart(success:ms:)`,
`noteShutterArrival(foreground:)`, `exportCSV()`, `summary`.

## What is left, in order (acceptance criteria in parentheses)
1. Integrate and build: `cd capture-app && xcodebuild -project ShiftMemory.xcodeproj -scheme ShiftMemory -destination 'platform=iOS Simulator,id=A31C14F7-1EC0-4D60-9807-F3DD037D4A1E' -derivedDataPath /tmp/sm-dd build`
   then `… test`. (Zero errors; unit tests green.) Fast per-file check: `Tools/typecheck.sh <files>` / `--tests`.
2. UI (replace `UI/RootView.swift`): one NavigationStack. Home: brand + backend pill (db, reachable dot) + Settings; glasses
   card (device name, battery, phase pill, one primary action per phase: Connect / Start shift / End shift / Restart, error line,
   firmware/glasses-app update buttons when flagged); capture card (ink Capture button ≥56 pt, label + note fields, transfer
   progress); recent events list (thumbnail, mono time, source SF Symbol, summary or "Reading the photo…", StatusPill per stage);
   pending-uploads banner with Retry (`queue.kick()`); photo picker for `manual_upload`. Event detail: full photo, fields,
   provenance, add note/label via `model.setNote/setLabel`. Settings (grouped list): backend host/db/token (secure) + Test
   connection (ping, shows offset), wearer name, device id with copy ("give this to Gary for demo/wearers.csv"), capture
   resolution/quality, blur faces, keep session in background, camera-roll import toggles + counts + Scan now, Diagnostics link,
   About. Diagnostics screen: summary (medians by profile, failure rates, backgrounded shutter count, drain/hour), rows, Export CSV
   (ShareLink), Reset. DEBUG-only Debug menu: MockDeviceKit enable/pair `.rayBanMeta`/powerOn/unfold/don/setBatteryLevel, set
   captured photo from bundled `Resources/Fixtures/rack-panel-fault.jpg` / `-ok.jpg`, `simulateCaptureFailure()`,
   `glasses.debugSimulateShutterPress()`. Follow `.claude/skills/impeccable/reference/ios.md` (native controls, Dynamic Type,
   SF Symbols, 44 pt targets, system materials) and `craft-floor.md`; palette/type/density from `UI/Theme.swift` so it reads as
   one product with the web console (`web/DESIGN.md`). (Looks like the console's sibling; passes the iOS slop test.)
3. Run in the Simulator with MockDeviceKit end to end: pair → Start shift → set fixture → Capture → event shows
   queued → uploading → (with no token) failed "invalid token" or, with Edward's token, accepted → in_graph with the module's
   summary. Screenshot light + dark (`xcrun simctl io <udid> screenshot`). (Screenshots attached to the PR.)
4. `capture-app/README.md`: build/run (Xcode 27.2, team, Developer Mode in Meta AI: Settings > App Info > tap version 5×, Connect),
   Config.plist, screens, how stages map to module statuses, limits (dev builds only, photo capture is beta, backgrounded delivery
   unknown until #10), pointer to MEASUREMENTS.md.
5. Device build for Edward: `xcodebuild … -destination 'generic/platform=iOS' -allowProvisioningUpdates build` or Xcode ⌘R on
   his iPhone 17 (UDID 00008150-00020DD43E40C01C). He runs MEASUREMENTS.md on real glasses and reports in #log.
6. PR: update description, mark ready for review, `Closes #1`, references #2 #10 #11; post `[DONE] (Claude)` in #log with what
   is verified and what is not (hardware), ask Gary to seed `demo/wearers.csv` with the device id shown in Settings.
