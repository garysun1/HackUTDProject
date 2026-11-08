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
  let floor: FloorStore

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
    floor = FloorStore(repository: FloorRepository(client: client), log: { DebugLog.write("Floor", $0) })
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
    coordinator.onGlassesPhotoQueued = { [weak self] event in
      guard let self, self.handoffPending else { return }
      self.handoffPending = false
      DebugLog.write("Shift", "handoff photo \(event.id) queued (note: \(event.note ?? "none")); ending shift")
      self.finishShift(reason: "ended by operator after handoff")
    }
    glasses.onEvent = { [weak self] event in self?.record(event) }
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
        if cameBack { await self.queue.kick(); await self.ping() }
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
    await ping()
    if config.cameraRollImportEnabled { await importer.setEnabled(true) }
  }

  /// The moment a photo is taken (glasses press or Capture tap): chime, then listen for context.
  private func captureFeedback() {
    if config.shutterSound { shutterSound.play() }
    startListening()
  }

  private func startListening() {
    narrator.isEnabled = config.voiceContext
    audio.useGlassesMic = config.useGlassesMic
    if config.voiceContext { narrator.begin() }
  }

  // MARK: - Shift lifecycle

  /// Start shift: open the glasses session right away (it takes ~2 s) and, unless turned off, show
  /// the briefing; the wearer confirms they are up to speed before they start working.
  func beginShift() {
    notice = nil
    Task { await glasses.startShift() }
    if config.voiceContext { Task { _ = await narrator.requestAuthorization() } }
    if config.briefingOnStart { presentBriefing(.shiftStart) }
  }

  func presentBriefing(_ mode: BriefingMode) {
    briefingMode = mode
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
    briefing = BriefingBuilder.build(
      snapshot: floor.snapshot, myDeviceId: config.deviceId,
      myName: config.wearerName.isEmpty ? "you" : config.wearerName,
      since: since, now: Date(), handoffText: handoffText
    )
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
    DebugLog.write("Shift", "briefing acknowledged (\(briefing?.needsYou.count ?? 0) open items)")
    speaker.stop()
    briefingPresented = false
  }

  func skipBriefing() {
    DebugLog.write("Shift", "briefing skipped")
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
