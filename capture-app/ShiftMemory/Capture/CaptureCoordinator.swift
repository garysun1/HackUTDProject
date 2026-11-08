//
// CaptureCoordinator.swift
// Shift Memory
//
// Turns photo bytes from any path (glasses listener, camera-roll import, manual pick) into one
// event: run the image pipeline (resize, blur faces, JPEG), build the CaptureEvent with the
// contract's timestamp rules, keep a copy for the wearer, hand the upload to the queue, and
// record the timings diagnostics needs for issue #10.
//

import Foundation
import UIKit

@MainActor
final class CaptureCoordinator {
  private let config: AppConfig
  private let pipeline: any ImagePipelineProtocol
  private let store: EventStore
  private let queue: UploadQueue
  private let diagnostics: DiagnosticsStore

  /// Phone clock minus server clock from the latest ping; informational on the event.
  var clockOffsetMs: Int?
  /// Waits for the wearer's spoken context for this photo (FIFO with presses) and returns it.
  /// Set by the composition root to `VoiceNarrator.takeNarration`; nil when voice is off.
  var takeSpokenNote: (() async -> String?)?
  /// Called after a glasses photo has been handed to the upload queue (end-of-shift handoff uses it).
  var onGlassesPhotoQueued: ((CaptureEvent) -> Void)?
  /// The note the wearer typed for a photo, the moment the photo is taken (calibration ground truth).
  var onTypedNote: ((String) -> Void)?
  /// The phone's best fix for the moment a photo was taken (contract v3.1), or nil.
  var locationAt: ((Date) -> LocationFix?)?
  /// The shift that was open at a given instant (attached to glasses photos), or nil.
  var shiftIdAt: ((Date) -> String?)?
  /// Whether the wearer allows location on photos (Settings › Location).
  var locationAllowed: (() -> Bool)?

  init(config: AppConfig, pipeline: any ImagePipelineProtocol, store: EventStore, queue: UploadQueue, diagnostics: DiagnosticsStore) {
    self.config = config
    self.pipeline = pipeline
    self.store = store
    self.queue = queue
    self.diagnostics = diagnostics
  }

  // MARK: - Entry points

  /// A photo from the glasses, by the shutter button or an app capture.
  func handle(_ photo: GlassesPhoto) async {
    let source: CaptureSource = photo.isAppRequested ? .sdkCapture : .shutterButton
    let metricsId = photo.captureId ?? UUID().uuidString.lowercased()
    _ = diagnostics.begin(id: metricsId, source: source)
    diagnostics.update(id: metricsId) { m in
      // App captures already have a row from AppModel.capture(); shutter-initiated captures (Inputs
      // path) get their request time here so captureToBytesMs covers both.
      m.requestedAt = m.requestedAt ?? photo.requestedAt
      m.firstProgressAt = photo.firstProgressAt
      m.bytesAt = photo.receivedAt
      m.bytes = photo.data.count
      m.format = ImageFormat.sniff(photo.data)
      m.requestedResolution = photo.requestedResolution
      m.requestedQuality = photo.requestedQuality
      m.appStateAtArrival = photo.appState
      m.glassesBattery = photo.glassesBattery
      m.phoneBattery = CaptureCoordinator.phoneBatteryPercent()
    }
    if !photo.isAppRequested { diagnostics.noteShutterArrival(foreground: photo.appState == "active") }
    diagnostics.recordBattery(glasses: photo.glassesBattery, phone: CaptureCoordinator.phoneBatteryPercent())

    // Read (and clear) the pending fields now, so a press that lands while this photo waits for its
    // spoken note does not inherit them.
    let label = config.pendingLabel
    let typed = config.pendingNote
    let prefix = config.pendingNotePrefix
    config.pendingLabel = ""
    config.pendingNote = ""
    config.pendingNotePrefix = ""
    if !typed.isEmpty { onTypedNote?(typed) }

    // The wearer talks while the photo crosses from the glasses; hold the upload until they finish
    // so perception (which reads the note) gets the context. The narrator caps the wait.
    // Position at the moment of the press / request, read now (before the narration wait) so a
    // wearer who walks on while talking is placed where the photo was taken.
    let capturedAt = photo.requestedAt ?? photo.receivedAt
    let location = locationAt?(capturedAt)
    let locationAgeMs = location.map { Int((capturedAt.timeIntervalSince($0.t) * 1000).rounded()) }
    let shiftId = shiftIdAt?(capturedAt)

    let spoken = await takeSpokenNote?()
    let note = Self.composeNote(prefix: prefix, typed: typed, spoken: spoken)

    // Contract: client_t is the capture timestamp the SDK delivers, else EXIF DateTimeOriginal.
    // The toolkit's timestamp is phone-side arrival, so EXIF wins when the bytes carry it.
    if let event = await ingest(
      data: photo.data, source: source, metricsId: metricsId,
      fallbackDate: photo.deliveredAt, fallbackOffset: TimeZone.current.secondsFromGMT(),
      label: label, note: note, location: location, locationAgeMs: locationAgeMs, shiftId: shiftId
    ) {
      onGlassesPhotoQueued?(event)
    }
  }

  /// "Handoff: " + typed note + spoken note, joined as sentences; nil when all are empty.
  static func composeNote(prefix: String, typed: String, spoken: String?) -> String? {
    let parts = [typed, spoken ?? ""].map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    let body = parts.map { p in p.last.map { ".!?".contains($0) } == true ? p : p + "." }.joined(separator: " ")
    let pre = prefix.trimmingCharacters(in: .whitespaces)
    if body.isEmpty { return pre.isEmpty || pre.hasSuffix(":") ? nil : pre }
    return pre.isEmpty ? body : pre + " " + body
  }

  /// A photo synced into the Photos library by the Meta AI app (fallback path, issue #2).
  func handleImported(_ photo: ImportedPhoto) async {
    let metricsId = "import-" + photo.localIdentifier.replacingOccurrences(of: "/", with: "_")
    _ = diagnostics.begin(id: metricsId, source: .cameraRoll)
    diagnostics.update(id: metricsId) { m in
      m.bytesAt = Date()
      m.bytes = photo.data.count
      m.format = ImageFormat.sniff(photo.data)
      m.originalPixels = "\(photo.pixelWidth)x\(photo.pixelHeight)"
    }
    await ingest(
      data: photo.data, source: .cameraRoll, metricsId: metricsId,
      fallbackDate: photo.creationDate, fallbackOffset: TimeZone.current.secondsFromGMT(),
      label: nil, note: nil,
      // The photo's own position, under the same switch and accuracy rule as phone fixes.
      location: (locationAllowed?() ?? false) ? photo.location.flatMap { $0.accuracyM <= LocationFix.maxEventAccuracyM ? $0 : nil } : nil,
      locationAgeMs: nil, shiftId: nil
    )
  }

  /// A photo the wearer picked from the library by hand (demo fallback; also the simulator path).
  func handleManual(_ data: Data, creationDate: Date?) async {
    let metricsId = UUID().uuidString.lowercased()
    _ = diagnostics.begin(id: metricsId, source: .manualUpload)
    diagnostics.update(id: metricsId) { m in
      m.bytesAt = Date()
      m.bytes = data.count
      m.format = ImageFormat.sniff(data)
    }
    await ingest(
      data: data, source: .manualUpload, metricsId: metricsId,
      fallbackDate: creationDate ?? Date(), fallbackOffset: TimeZone.current.secondsFromGMT(),
      label: config.pendingLabel,
      note: Self.composeNote(prefix: config.pendingNotePrefix, typed: config.pendingNote, spoken: nil),
      location: nil, locationAgeMs: nil, shiftId: nil
    )
    if !config.pendingNote.isEmpty { onTypedNote?(config.pendingNote) }
    config.pendingLabel = ""
    config.pendingNote = ""
    config.pendingNotePrefix = ""
  }

  // MARK: - Shared path

  @discardableResult
  private func ingest(data: Data, source: CaptureSource, metricsId: String,
                      fallbackDate: Date, fallbackOffset: Int, label: String?, note: String?,
                      location: LocationFix?, locationAgeMs: Int?, shiftId: String?) async -> CaptureEvent? {
    let options = PipelineOptions(blurFaces: config.blurFaces)
    let prepared: PreparedPhoto
    do {
      prepared = try await pipeline.prepare(data, options: options)
    } catch {
      diagnostics.update(id: metricsId) { $0.error = "pipeline: \(error)" }
      return nil
    }

    // For camera-roll imports the library's creation date is authoritative (contract).
    let clientT: Date
    let offset: Int
    if source == .cameraRoll {
      clientT = fallbackDate
      offset = fallbackOffset
    } else {
      clientT = prepared.exifDate ?? fallbackDate
      offset = prepared.exifOffsetSeconds ?? fallbackOffset
    }

    let trimmedLabel = label?.trimmingCharacters(in: .whitespacesAndNewlines)
    let trimmedNote = note?.trimmingCharacters(in: .whitespacesAndNewlines)
    let event = CaptureEvent(
      deviceId: config.deviceId,
      clientT: clientT,
      clientTZOffsetSeconds: offset,
      source: source,
      note: (trimmedNote?.isEmpty ?? true) ? nil : trimmedNote,
      label: (trimmedLabel?.isEmpty ?? true) ? nil : trimmedLabel,
      clockOffsetMs: clockOffsetMs,
      wearer: config.wearerName.isEmpty ? nil : config.wearerName,
      width: prepared.width,
      height: prepared.height,
      jpegBytes: prepared.jpeg.count,
      facesBlurred: prepared.facesBlurred,
      location: location,
      locationAgeMs: locationAgeMs,
      shiftId: shiftId,
      stage: .queued
    )

    diagnostics.rename(id: metricsId, to: event.id)
    diagnostics.update(id: event.id) { m in
      m.pipelineMs = prepared.processingMs
      m.originalPixels = "\(prepared.originalPixelWidth)x\(prepared.originalPixelHeight)"
      if m.format == nil || m.format == .unknown { m.format = prepared.originalFormat }
      m.uploadStartedAt = Date()
    }

    store.add(event, jpeg: prepared.jpeg, thumbnail: prepared.thumbnail)
    await queue.enqueue(event, jpeg: prepared.jpeg)
    return event
  }

  static func phoneBatteryPercent() -> Int? {
    let device = UIDevice.current
    device.isBatteryMonitoringEnabled = true
    let level = device.batteryLevel
    return level < 0 ? nil : Int((level * 100).rounded())
  }
}
