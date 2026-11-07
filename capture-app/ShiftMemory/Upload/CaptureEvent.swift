//
// CaptureEvent.swift
// Shift Memory
//
// The phone-side record of one photo-event, from bytes arriving to `in_graph` on Maincloud.
// Field names follow docs/CONTRACT.md; the JSON the module receives is built in EventEnvelope.
//

import Foundation

/// How the photo reached the app. Raw values are the contract's `source` strings.
enum CaptureSource: String, Codable, Sendable, CaseIterable {
  case shutterButton = "shutter_button"
  case sdkCapture = "sdk_capture"
  case cameraRoll = "camera_roll"
  case manualUpload = "manual_upload"

  var label: String {
    switch self {
    case .shutterButton: "glasses shutter"
    case .sdkCapture: "app capture"
    case .cameraRoll: "camera roll"
    case .manualUpload: "manual upload"
    }
  }
  var systemImage: String {
    switch self {
    case .shutterButton: "eyeglasses"
    case .sdkCapture: "camera"
    case .cameraRoll: "photo.on.rectangle"
    case .manualUpload: "square.and.arrow.up"
    }
  }
}

/// Where the event is. The first three are phone-side; the rest mirror `event.status` on the module.
enum EventStage: String, Codable, Sendable, CaseIterable {
  case processing   // pipeline: decode, resize, blur, encode
  case queued       // waiting for the network or a retry
  case uploading
  case accepted     // stored by the module; perception scheduled
  case inGraph = "in_graph"
  case duplicate    // the module already had this event_id
  case failed       // non-retryable upload error, or the module could not read the photo

  var label: String {
    switch self {
    case .processing: "processing"
    case .queued: "queued"
    case .uploading: "uploading"
    case .accepted: "accepted"
    case .inGraph: "in graph"
    case .duplicate: "duplicate"
    case .failed: "failed"
    }
  }
  var isTerminal: Bool { self == .inGraph || self == .duplicate || self == .failed }
  var isPendingUpload: Bool { self == .queued || self == .uploading }
}

struct CaptureEvent: Identifiable, Codable, Sendable, Hashable {
  /// `event_id`: uuid4, lowercase, generated on the phone. The idempotency key.
  let id: String
  let deviceId: String
  /// `client_t`: the capture time (EXIF DateTimeOriginal, else the SDK delivery time; for camera
  /// roll the asset's creation date). Formatted with `clientTZOffsetSeconds` when sent.
  let clientT: Date
  let clientTZOffsetSeconds: Int
  let source: CaptureSource
  var note: String?
  var label: String?
  var clockOffsetMs: Int?
  var wearer: String?
  let width: Int
  let height: Int
  let jpegBytes: Int
  let facesBlurred: Int

  var stage: EventStage
  var serverT: Date?
  /// `event.summary` from the module once perception has run.
  var summary: String?
  var lastError: String?
  var attempts: Int
  var nextAttemptAt: Date?
  /// Phone wall clock when the event record was created.
  let createdAt: Date
  var acceptedAt: Date?
  var inGraphAt: Date?

  init(
    id: String = UUID().uuidString.lowercased(),
    deviceId: String,
    clientT: Date,
    clientTZOffsetSeconds: Int = TimeZone.current.secondsFromGMT(),
    source: CaptureSource,
    note: String? = nil,
    label: String? = nil,
    clockOffsetMs: Int? = nil,
    wearer: String? = nil,
    width: Int,
    height: Int,
    jpegBytes: Int,
    facesBlurred: Int = 0,
    stage: EventStage = .queued,
    createdAt: Date = Date()
  ) {
    self.id = id
    self.deviceId = deviceId
    self.clientT = clientT
    self.clientTZOffsetSeconds = clientTZOffsetSeconds
    self.source = source
    self.note = note
    self.label = label
    self.clockOffsetMs = clockOffsetMs
    self.wearer = wearer
    self.width = width
    self.height = height
    self.jpegBytes = jpegBytes
    self.facesBlurred = facesBlurred
    self.stage = stage
    self.attempts = 0
    self.createdAt = createdAt
  }

  var photoFileName: String { "\(id).jpg" }
  var thumbnailFileName: String { "\(id).thumb.jpg" }
}
