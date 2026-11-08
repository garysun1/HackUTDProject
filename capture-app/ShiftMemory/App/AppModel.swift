//
// AppModel.swift
// Shift Memory
//
// Composition root. Owns every long-lived object, wires the glasses listener and the camera-roll
// importer into the capture coordinator, feeds upload-queue updates into the event store, watches
// the network and app lifecycle, and pings the backend for reachability and clock offset.
//

import Foundation
import MWDATCamera
import Network
import Observation
import UIKit

/// One item on the serial photo lane: a delivered photo, or a requested capture that never arrived.
enum PhotoLaneItem: Sendable {
  case photo(GlassesPhoto)
  case abandoned
}

@MainActor
@Observable
final class AppModel {
  let config: AppConfig
  let glasses: GlassesController
  let store: EventStore
  let diagnostics: DiagnosticsStore
  let importer: CameraRollImporter
  let client: IngestClient
  let queue: UploadQueue
  let pipeline: ImagePipeline
  let coordinator: CaptureCoordinator
  let audio: AudioSessionCoordinator
  let shutterSound: ShutterSound
  let narrator: VoiceNarrator
  let speaker: BriefingSpeaker
  let nvidia: NvidiaClient
  let elevenLabs: ElevenLabsClient
  let briefingCheck: BriefingCheck
  let floor: FloorStore
  let location: LocationTracker
  /// Barometric floor during a shift (#19); feeds `LocationFix.floor` through `location`.
  let altimeter: AltimeterFloorTracker
  let trackStore: TrackStore
  let trackUploader: TrackUploader
  /// Recent fixes (last 10 min) so a photo is placed where it was taken, not where the wearer stood
  /// when its bytes finished arriving.
  private var recentFixes: [LocationFix] = []
  /// The last shift that was closed, so a photo pressed before End shift but delivered after it still
  /// carries that shift's id.
  private var lastClosedShift: (id: String, start: Date, end: Date)?
  /// A shift is closed automatically after this long (a forgotten End shift must not track overnight).
  static let maxShiftDuration: TimeInterval = 16 * 3600

  // MARK: Shift briefing / handoff (UI state)
  enum BriefingMode: Equatable { case shiftStart, review }
  var briefingPresented = false
  private(set) var briefingMode: BriefingMode = .review
  private(set) var briefing: Briefing?
  private(set) var briefingLoading = false
  private(set) var briefingError: String?
  var endShiftPresented = false
  /// End the shift as soon as the closing (handoff) photo has been queued for upload.
  private(set) var handoffPending = false
  /// A one-line instruction for the wearer ("Press the shutter at PDU A…"), shown on Home.
  var notice: String?

  private(set) var isOnline = true
  private(set) var isStarted = false
  private var monitor: NWPathMonitor?
  private var tasks: [Task<Void, Never>] = []
  /// Debounce for token edits → `queue.kick()`.
  private var tokenRetry: Task<Void, Never>?

  init() {
    let support = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
      ?? FileManager.default.temporaryDirectory
    let config = AppConfig()
    self.config = config
    glasses = GlassesController()
    store = EventStore(directory: support.appending(path: "Events"))
    diagnostics = DiagnosticsStore(directory: support.appending(path: "Diagnostics"))
    importer = CameraRollImporter()
    pipeline = ImagePipeline()
    // Read at call time so Settings edits apply to the next request. The client calls this from the
    // upload queue's actor, so it must not touch main-actor state (MainActor.assumeIsolated trapped
    // here with EXC_BREAKPOINT on the first real upload).
    let endpointSnapshot = config.endpointSnapshot
    client = IngestClient(endpoint: { endpointSnapshot.value })
    queue = UploadQueue(
      client: client,
      directory: support.appending(path: "UploadQueue"),
      configuration: { [config] in
        await MainActor.run { UploadQueue.Configuration(ingestToken: config.ingestToken, appVersion: config.appVersion) }
      }
    )
    coordinator = CaptureCoordinator(config: config, pipeline: pipeline, store: store, queue: queue, diagnostics: diagnostics)
    let audio = AudioSessionCoordinator()
    self.audio = audio
    // With voice on, the chime already puts the session in record mode so the narration that follows
    // starts on the same route (the glasses, when connected) without a category switch.
    shutterSound = ShutterSound(prepareAudio: { [config, audio] in
      audio.useGlassesMic = config.useGlassesMic
      do {
        if config.voiceContext { try audio.activateForRecording() } else { try audio.activateForPlayback() }
      } catch {
        DebugLog.write("Audio", "activate for chime failed: \(error)")
      }
    })
    narrator = VoiceNarrator(audio: audio, log: { DebugLog.write("Voice", $0) })
    speaker = BriefingSpeaker(prepareAudio: { [audio] in
      do { try audio.activateForPlayback() } catch { DebugLog.write("Audio", "activate for briefing failed: \(error)") }
    })
    let keySnapshot = config.nvidiaKeySnapshot
    let nvidia = NvidiaClient(apiKey: { keySnapshot.value })
    self.nvidia = nvidia
    speaker.log = { DebugLog.write("Speaker", $0) }
    let elevenKey = config.elevenLabsKeySnapshot
    let elevenVoice = config.elevenLabsVoiceSnapshot
    let elevenLabs = ElevenLabsClient(apiKey: { elevenKey.value }, voiceId: { elevenVoice.value })
    self.elevenLabs = elevenLabs
    // Voice: ElevenLabs when its key is set, else Magpie (NVIDIA key), else the speaker's system voice.
    speaker.synthesize = { [elevenLabs, nvidia] text in
      if elevenLabs.hasKey { return try await elevenLabs.synthesize(text) }
      guard nvidia.hasKey else { throw NvidiaError(kind: .noKey, detail: "") }
      return try await nvidia.synthesize(text)
    }
    briefingCheck = BriefingCheck(nvidia: nvidia, speaker: speaker, narrator: narrator, log: { DebugLog.write("Briefing", $0) })
    floor = FloorStore(repository: FloorRepository(client: client), log: { DebugLog.write("Floor", $0) })
    location = LocationTracker(log: { DebugLog.write("Location", $0) })
    altimeter = AltimeterFloorTracker(log: { DebugLog.write("Floor", $0) },
                                      config: FloorQuantizer.Config(floorHeightM: config.floorHeightM))
    let trackStore = TrackStore(directory: support.appending(path: "Track"))
    self.trackStore = trackStore
    trackUploader = TrackUploader(
      store: trackStore, client: client,
      context: { [config] in
        guard config.isBackendConfigured, config.hasIngestToken else { return nil }
        return TrackUploader.Context(deviceId: config.deviceId, ingestToken: config.ingestToken, appVersion: config.appVersion)
      },
      log: { DebugLog.write("Track", $0) }
    )
  }

  /// Call once, from the root view's `.task`.
  func start() async {
    guard !isStarted else { return }
    isStarted = true

    // Photos are processed one at a time, in arrival order, off the glasses' delivery path: a photo
    // may wait up to ~30 s for its spoken note, and that must not hold up the next capture.
    // Each requested capture is paired with one narration (FIFO). A capture that is abandoned (timeout,
    // camera error, shift ended) releases its narration through the same serial lane, so a later photo
    // can never pick up an earlier capture's words.
    let (photos, photoSink) = AsyncStream.makeStream(of: PhotoLaneItem.self)
    glasses.onPhoto = { photo in photoSink.yield(.photo(photo)) }
    glasses.onCaptureAbandoned = { count in for _ in 0..<count { photoSink.yield(.abandoned) } }
    tasks.append(Task { [weak self] in
      for await item in photos {
        guard let self else { return }
        switch item {
        case .photo(let photo):
          await self.coordinator.handle(photo)
        case .abandoned:
          let words = await self.narrator.takeNarration(timeout: .seconds(35))
          DebugLog.write("Voice", "capture abandoned; released its narration: \(words ?? "(none)")")
          if let words, !words.isEmpty {
            self.notice = "That photo did not arrive, so this note was not attached: “\(words)”"
          }
        }
      }
    })
    audio.onInterruption = { [weak self] began in self?.narrator.handleInterruption(began: began) }
    narrator.isEnabled = config.voiceContext
    audio.useGlassesMic = config.useGlassesMic
    coordinator.takeSpokenNote = { [weak self] in
      guard let self else { return nil }
      return await self.narrator.takeNarration(timeout: .seconds(35))
    }
    coordinator.locationAt = { [weak self] date in self?.fix(near: date) }
    coordinator.shiftIdAt = { [weak self] date in self?.shiftId(at: date) }
    coordinator.locationAllowed = { [weak self] in self?.config.locationEnabled ?? false }
    location.barometricFloor = { [weak self] in self?.altimeter.floor }
    config.onFloorHeightChanged = { [weak self] height in
      self?.altimeter.setConfig(FloorQuantizer.Config(floorHeightM: height))
    }
    location.onTrackPoint = { [weak self] fix in
      guard let self else { return }
      self.enforceShiftLimit()
      guard let shiftId = self.config.activeShiftId else { return }
      self.remember(fix)
      Task { await self.trackStore.append(fix, shiftId: shiftId) }
    }
    coordinator.onGlassesPhotoQueued = { [weak self] event in
      guard let self, self.handoffPending else { return }
      self.handoffPending = false
      DebugLog.write("Shift", "handoff photo \(event.id) queued (note: \(event.note ?? "none")); ending shift")
      self.finishShift(reason: "ended by operator after handoff")
    }
    glasses.onEvent = { [weak self] event in self?.record(event) }
    briefingCheck.onPassed = { [weak self] note in
      guard let self, self.briefingPresented else { return }
      // The acknowledgement rides on the shift's first photo as its note, so it reaches the graph.
      if self.config.pendingNotePrefix.isEmpty { self.config.pendingNotePrefix = note }
      self.acknowledgeBriefing()
    }
    // The chime marks the press itself; listening starts once the press is accepted as a capture.
    glasses.onShutterPress = { [weak self] in
      guard let self, self.config.shutterSound else { return }
      self.shutterSound.play()
    }
    glasses.onShutterAccepted = { [weak self] in self?.startListening() }
    glasses.startObserving()

    config.onIngestTokenChanged = { [weak self] in
      guard let self else { return }
      tokenRetry?.cancel()
      tokenRetry = Task { [weak self] in
        try? await Task.sleep(for: .seconds(1.5))
        guard let self, !Task.isCancelled else { return }
        await self.queue.kick()
        await self.ping()
        self.trackUploader.kick()
        self.enforceShiftLimit()
        self.startLocation()
      }
    }

    importer.onlyGlassesPhotos = config.cameraRollOnlyGlassesPhotos
    importer.onPhoto = { [weak self] photo in await self?.coordinator.handleImported(photo) }

    tasks.append(Task { [weak self] in
      guard let self else { return }
      for await update in self.queue.updates {
        self.store.apply(update)
        self.recordUploadStage(update)
      }
    })
    await queue.start()

    let monitor = NWPathMonitor()
    self.monitor = monitor
    monitor.pathUpdateHandler = { [weak self] path in
      let online = path.status == .satisfied
      Task { @MainActor in
        guard let self else { return }
        let cameBack = online && !self.isOnline
        self.isOnline = online
        if cameBack { await self.queue.kick(); await self.ping(); self.trackUploader.kick() }
      }
    }
    monitor.start(queue: DispatchQueue(label: "shiftmemory.network"))

    tasks.append(Task { [weak self] in
      for await _ in NotificationCenter.default.notifications(named: UIApplication.didEnterBackgroundNotification) {
        guard let self else { return }
        glassesLog("app: didEnterBackground (phase=\(self.glasses.phase), keepSessionInBackground=\(self.config.keepSessionInBackground))")
        if !self.config.keepSessionInBackground { self.glasses.endShift(reason: "Ended when the app went to the background.") }
      }
    })
    tasks.append(Task { [weak self] in
      for await _ in NotificationCenter.default.notifications(named: UIApplication.willEnterForegroundNotification) {
        guard let self else { return }
        glassesLog("app: willEnterForeground (phase=\(self.glasses.phase))")
        await self.queue.kick()
        await self.ping()
        if self.config.cameraRollImportEnabled { await self.importer.scanNow() }
      }
    })

    syncShutterSettings()
    trackUploader.start()
    // A shift left open for more than 16 h was forgotten, not worked: close it rather than track on.
    enforceShiftLimit()
    startLocation()
    tasks.append(Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(300))
        self?.enforceShiftLimit()
      }
    })
    await ping()
    if config.cameraRollImportEnabled { await importer.setEnabled(true) }
  }

  /// The moment a photo is taken (glasses press or Capture tap): chime, then listen for context.
  private func captureFeedback() {
    if config.shutterSound { shutterSound.play() }
    startListening()
  }

  private func startListening() {
    // The press is the moment the photo is taken: keep the fix from now for placing it.
    if let fix = location.freshFix() { remember(fix) }
    narrator.isEnabled = config.voiceContext
    audio.useGlassesMic = config.useGlassesMic
    if config.voiceContext { narrator.begin() }
  }

  // MARK: - Shift lifecycle

  /// Start shift: open the glasses session right away (it takes ~2 s) and, unless turned off, show
  /// the briefing; the wearer confirms they are up to speed before they start working.
  func beginShift() {
    notice = nil
    // A handoff requested earlier but never taken must not end this (resumed) shift with its first photo.
    if handoffPending || config.pendingNotePrefix == "Handoff:" {
      DebugLog.write("Shift", "discarding an unfinished handoff request")
      handoffPending = false
      if config.pendingNotePrefix == "Handoff:" { config.pendingNotePrefix = "" }
    }
    openShiftIfNeeded()
    Task { await glasses.startShift() }
    if config.voiceContext { Task { _ = await narrator.requestAuthorization() } }
    if config.briefingOnStart { presentBriefing(.shiftStart) }
  }

  func presentBriefing(_ mode: BriefingMode) {
    briefingMode = mode
    briefing = nil
    briefingPresented = true
    Task { await loadBriefing() }
  }

  /// What happened since this wearer was last here: at least the last 12 h, at most 36 h.
  var briefingSince: Date {
    let now = Date()
    let floorWindow = now.addingTimeInterval(-12 * 3600)
    guard let last = config.lastShiftEndedAt else { return floorWindow }
    return max(min(last, floorWindow), now.addingTimeInterval(-36 * 3600))
  }

  func loadBriefing() async {
    briefingLoading = true
    briefingError = nil
    defer { briefingLoading = false }
    await floor.refresh()
    if let error = floor.lastError, floor.snapshot.fetchedAt == .distantPast {
      briefingError = error
      return
    }
    let since = briefingSince
    let handoffText = await latestHandoffText(since: since)
    let built = BriefingBuilder.build(
      snapshot: floor.snapshot, myDeviceId: config.deviceId,
      myName: config.wearerName.isEmpty ? "you" : config.wearerName,
      since: since, now: Date(), handoffText: handoffText
    )
    let first = briefing == nil
    briefing = built
    if first, briefingMode == .shiftStart, briefingPresented, config.spokenBriefingCheck {
      briefingCheck.run(built, wearer: config.wearerName)
    }
  }

  /// The spoken check again, from the top (the Read-it button while a check is on).
  func rerunBriefingCheck() {
    guard let briefing else { return }
    briefingCheck.run(briefing, wearer: config.wearerName)
  }

  func briefingListenAgain() {
    guard let briefing else { return }
    briefingCheck.listenAgain(briefing: briefing, wearer: config.wearerName)
  }

  /// The newest generated handoff (module #8) inside the window, if the pipeline has written one.
  private func latestHandoffText(since: Date) async -> String? {
    guard let rows = try? await client.sql("SELECT text, generated_micros FROM handoff") else { return nil }
    let sinceMicros = UInt64(since.timeIntervalSince1970 * 1_000_000)
    return rows
      .compactMap { r -> (String, UInt64)? in
        guard let text = r[safe: 0]?.string, !text.isEmpty, let at = r[safe: 1]?.uint64, at >= sinceMicros else { return nil }
        return (text, at)
      }
      .max { $0.1 < $1.1 }?.0
  }

  func acknowledgeBriefing() {
    config.lastBriefingAckAt = Date()
    DebugLog.write("Shift", "briefing acknowledged (\(briefing?.needsYou.count ?? 0) open items; check: \(briefingCheck.phase))")
    if briefingCheck.phase != .passed { briefingCheck.cancel() }
    speaker.stop()
    briefingPresented = false
  }

  func skipBriefing() {
    DebugLog.write("Shift", "briefing skipped")
    briefingCheck.cancel()
    speaker.stop()
    briefingPresented = false
  }

  /// End shift asks for a handoff first; the closing photo's narration is what the next person hears.
  func requestEndShift() { endShiftPresented = true }

  /// Take the closing photo now; what the wearer says becomes a "Handoff:" note, then the shift ends.
  func recordHandoff() {
    endShiftPresented = false
    config.pendingNotePrefix = "Handoff:"
    if glasses.phase == .ready {
      handoffPending = true
      capture()
    } else {
      handoffPending = true
      notice = "Press the shutter on the glasses and say what the next shift needs to know."
    }
  }

  func endShiftWithoutHandoff() {
    endShiftPresented = false
    finishShift(reason: "ended by operator")
  }

  private func finishShift(reason: String) {
    handoffPending = false
    notice = nil
    glasses.endShift(reason: reason)
    config.lastShiftEndedAt = Date()
    closeShift()
  }

  // MARK: - Shift identity and location (#19)

  /// A shift lasts from Start shift until End shift, across glasses dropouts and relaunches. A new
  /// id is minted only when none is open, or the open one is older than 16 h (forgotten End shift).
  private func openShiftIfNeeded() {
    let now = Date()
    if let id = config.activeShiftId, let started = config.activeShiftStartedAt, now.timeIntervalSince(started) < Self.maxShiftDuration {
      DebugLog.write("Shift", "continuing shift \(id.prefix(8))")
    } else {
      if let stale = config.activeShiftId {
        Task { [trackStore] in await trackStore.mark("shift_end", shiftId: stale, at: now) }
      }
      let id = UUID().uuidString.lowercased()
      config.activeShiftId = id
      config.activeShiftStartedAt = now
      Task { [trackStore] in await trackStore.mark("shift_start", shiftId: id, at: now) }
      DebugLog.write("Shift", "started shift \(id.prefix(8))")
    }
    startLocation()
  }

  private func closeShift() {
    guard let id = config.activeShiftId else { return }
    let now = Date()
    lastClosedShift = (id, config.activeShiftStartedAt ?? now, now)
    config.activeShiftId = nil
    config.activeShiftStartedAt = nil
    Task { [trackStore, trackUploader] in
      await trackStore.mark("shift_end", shiftId: id, at: now)
      trackUploader.kick()
    }
    DebugLog.write("Shift", "ended shift \(id.prefix(8))")
    startLocation()
  }

  /// Location mode follows the shift: tracking while one is open (also in the background), else
  /// foreground fixes only, so photos taken outside a shift are still placed. Off when disabled.
  func startLocation() {
    guard config.locationEnabled else { location.stop(); altimeter.stop(); return }
    if location.authorization == .notDetermined { location.requestAuthorization() }
    if config.activeShiftId != nil {
      if location.mode != .shift {
        location.startShift()
        // Relative altitude is zero where updates start: after a relaunch mid-shift that is the
        // wearer's current floor, not the floor the shift started on.
        if let started = config.activeShiftStartedAt, Date().timeIntervalSince(started) > 60 {
          DebugLog.write("Floor", "resuming a shift started \(Int(Date().timeIntervalSince(started) / 60)) min ago: floor 0 is the current floor, not the shift's first")
        }
        altimeter.startShift()
      }
    } else if location.mode == .shift {
      location.stopShift()
      altimeter.stop()
    } else if location.mode == .off {
      location.startForeground()
    }
  }

  /// Closes the open shift once it is older than `maxShiftDuration` (checked on every track point,
  /// on foreground, every 5 min, and at launch).
  func enforceShiftLimit(now: Date = Date()) {
    guard let started = config.activeShiftStartedAt, config.activeShiftId != nil,
          now.timeIntervalSince(started) > Self.maxShiftDuration else { return }
    DebugLog.write("Shift", "shift open for more than \(Int(Self.maxShiftDuration / 3600)) h; closing it")
    handoffPending = false
    if glasses.isSessionLive { glasses.endShift(reason: "Shift closed automatically after 16 hours") }
    config.lastShiftEndedAt = now
    closeShift()
  }

  /// Whether a location shift is open (it can outlive a glasses session that dropped).
  var isShiftOpen: Bool { config.activeShiftId != nil }

  /// The shift that was open at `date`: the current one if it had started, else the one closed most
  /// recently if `date` falls inside it.
  func shiftId(at date: Date) -> String? {
    if let id = config.activeShiftId, let started = config.activeShiftStartedAt, date >= started.addingTimeInterval(-5) { return id }
    if let last = lastClosedShift, date >= last.start.addingTimeInterval(-5), date <= last.end.addingTimeInterval(5) { return last.id }
    return nil
  }

  func setLocationEnabled(_ on: Bool) {
    config.locationEnabled = on
    startLocation()
  }

  /// The open shift (or, between shifts, the most recent one) as GeoJSON in a temporary file, for the
  /// share sheet: track line, shift marks, and every photo of that shift that has a position.
  func exportTrackGeoJSON() async -> URL? {
    let ids = await trackStore.shiftIds()
    guard let shiftId = config.activeShiftId ?? ids.first else { return nil }
    let history = await trackStore.history(shiftId: shiftId)
    let pins: [PhotoPin] = store.events.compactMap { e in
      guard e.shiftId == shiftId, let fix = e.location else { return nil }
      return PhotoPin(eventId: e.id, t: e.clientT, fix: fix, source: e.source.rawValue, note: e.note, summary: e.summary)
    }
    let data = ShiftGeoJSON.featureCollection(
      shiftId: shiftId, deviceId: config.deviceId, wearer: config.wearerName.isEmpty ? nil : config.wearerName,
      points: history.points, marks: history.marks, photos: pins)
    let url = FileManager.default.temporaryDirectory.appending(path: "shift-\(shiftId.prefix(8)).geojson")
    do {
      try data.write(to: url, options: .atomic)
      return url
    } catch {
      DebugLog.write("Track", "GeoJSON export failed: \(error)")
      return nil
    }
  }

  private func remember(_ fix: LocationFix) {
    if let last = recentFixes.last, fix.t <= last.t { return }
    recentFixes.append(fix)
    let cutoff = fix.t.addingTimeInterval(-600)
    recentFixes.removeAll { $0.t < cutoff }
  }

  /// The fix closest in time to `date` among recent ones that is valid for an event taken then; falls
  /// back to the tracker's freshest fix.
  func fix(near date: Date) -> LocationFix? {
    guard config.locationEnabled else { return nil }
    if let latest = location.latest { remember(latest) }
    return Self.bestFix(for: date, among: recentFixes) ?? location.freshFix(at: date).flatMap { Self.bestFix(for: date, among: [$0]) }
  }

  /// Where the wearer was when the photo was taken: the newest usable fix taken at or before the
  /// press (2 s tolerance for delivery jitter); only if none exists, the earliest usable fix after it
  /// (the wearer may have walked on, so later fixes are a last resort).
  nonisolated static func bestFix(for date: Date, among fixes: [LocationFix]) -> LocationFix? {
    let usable = fixes.filter { $0.isUsableForEvent(capturedAt: date) }
    if let before = usable.filter({ $0.t <= date.addingTimeInterval(2) }).max(by: { $0.t < $1.t }) { return before }
    return usable.filter { $0.t > date }.min { $0.t < $1.t }
  }

  /// From the floor map: the next photo is about this asset/issue. Labels it, and captures now when
  /// the glasses are ready (otherwise the wearer presses the shutter when they get there).
  func fixWithPhoto(asset: FloorAsset, issue: FloorIssue?) {
    config.pendingLabel = asset.name
    if let issue { config.pendingNotePrefix = "Re: \(issue.entityName) (\(issue.text))." }
    if glasses.phase == .ready {
      notice = "Say what you found or fixed at \(asset.name)."
      capture()
    } else {
      notice = "Next photo is labelled \(asset.name). Press the shutter when you are there and say what you see."
    }
  }

  /// Shutter-initiated captures use the same Settings as the Capture button.
  func syncShutterSettings() {
    glasses.shutterResolution = PhotoResolution(rawValue: config.captureResolution) ?? .full
    glasses.shutterQuality = PhotoQuality(rawValue: config.captureQuality) ?? .high
  }

  // MARK: - Intents

  /// Ask the glasses for a photo with the configured resolution and quality.
  func capture() {
    let resolution = PhotoResolution(rawValue: config.captureResolution) ?? .full
    let quality = PhotoQuality(rawValue: config.captureQuality) ?? .high
    syncShutterSettings()
    if let id = glasses.capture(resolution: resolution, quality: quality) {
      captureFeedback()
      _ = diagnostics.begin(id: id, source: .sdkCapture)
      diagnostics.update(id: id) { m in
        m.requestedAt = Date()
        m.requestedResolution = resolution.rawValue
        m.requestedQuality = quality.rawValue
      }
    }
  }

  func ping() async {
    guard config.isBackendConfigured else { store.backendReachable = nil; return }
    do {
      let result = try await client.ping()
      store.lastPing = result
      store.backendReachable = true
      store.lastBackendError = nil
      coordinator.clockOffsetMs = result.clockOffsetMs
    } catch {
      store.backendReachable = false
      store.lastBackendError = error.userMessage
    }
  }

  func setCameraRollImport(enabled: Bool) async {
    config.cameraRollImportEnabled = enabled
    await importer.setEnabled(enabled)
    if !enabled && importer.isEnabled { config.cameraRollImportEnabled = true }
  }

  func setNote(eventId: String, note: String) async throws(IngestError) {
    try await client.setNote(eventId: eventId, note: note)
    store.update(id: eventId) { $0.note = note.isEmpty ? nil : note }
  }

  func setLabel(eventId: String, label: String) async throws(IngestError) {
    try await client.setLabel(eventId: eventId, label: label)
    store.update(id: eventId) { $0.label = label.isEmpty ? nil : label }
  }

  func importPicked(_ data: Data) async {
    await coordinator.handleManual(data, creationDate: nil)
  }

  /// Mirror upload progress into the #10 diagnostics row (`acceptedAt`, `inGraphAt`, `error`), which
  /// the CSV reports; the event store keeps the wearer-facing copy.
  private func recordUploadStage(_ update: UploadQueue.Update) {
    let now = Date()
    switch update {
    case let .stage(eventId, stage, _, error, _):
      diagnostics.update(id: eventId) { m in
        switch stage {
        case .accepted, .duplicate: if m.acceptedAt == nil { m.acceptedAt = now }
        case .inGraph:
          if m.acceptedAt == nil { m.acceptedAt = now }
          if m.inGraphAt == nil { m.inGraphAt = now }
        case .failed: m.error = error ?? "upload failed"
        default: break
        }
      }
    case let .polled(eventId, status, _):
      diagnostics.update(id: eventId) { m in
        switch status {
        case "in_graph": if m.inGraphAt == nil { m.inGraphAt = now }
        case "failed": m.error = m.error ?? "module: perception failed"
        default: break
        }
      }
    default: break
    }
  }

  private func record(_ event: GlassesEvent) {
    switch event {
    case .sessionStartSucceeded(let ms): diagnostics.noteSessionStart(success: true, ms: ms, error: nil)
    case .sessionStartFailed(let error): diagnostics.noteSessionStart(success: false, ms: nil, error: error)
    case .photoStartSucceeded(let ms): diagnostics.notePhotoStart(success: true, ms: ms)
    case .photoStartFailed: diagnostics.notePhotoStart(success: false, ms: nil)
    case .sessionStopped: break
    }
  }
}
