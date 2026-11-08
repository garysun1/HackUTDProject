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

  private(set) var isOnline = true
  private(set) var isStarted = false
  private var monitor: NWPathMonitor?
  private var tasks: [Task<Void, Never>] = []

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
  }

  /// Call once, from the root view's `.task`.
  func start() async {
    guard !isStarted else { return }
    isStarted = true

    glasses.onPhoto = { [weak self] photo in await self?.coordinator.handle(photo) }
    glasses.onEvent = { [weak self] event in self?.record(event) }
    glasses.startObserving()

    importer.onlyGlassesPhotos = config.cameraRollOnlyGlassesPhotos
    importer.onPhoto = { [weak self] photo in await self?.coordinator.handleImported(photo) }

    tasks.append(Task { [weak self] in
      guard let self else { return }
      for await update in self.queue.updates { self.store.apply(update) }
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
        if !self.config.keepSessionInBackground { self.glasses.endShift(reason: "Ended when the app went to the background.") }
      }
    })
    tasks.append(Task { [weak self] in
      for await _ in NotificationCenter.default.notifications(named: UIApplication.willEnterForegroundNotification) {
        guard let self else { return }
        await self.queue.kick()
        await self.ping()
        if self.config.cameraRollImportEnabled { await self.importer.scanNow() }
      }
    })

    await ping()
    if config.cameraRollImportEnabled { await importer.setEnabled(true) }
  }

  // MARK: - Intents

  /// Ask the glasses for a photo with the configured resolution and quality.
  func capture() {
    let resolution = PhotoResolution(rawValue: config.captureResolution) ?? .full
    let quality = PhotoQuality(rawValue: config.captureQuality) ?? .high
    if let id = glasses.capture(resolution: resolution, quality: quality) {
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
