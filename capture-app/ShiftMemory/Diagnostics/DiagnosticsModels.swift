//
// DiagnosticsModels.swift
// Shift Memory
//
// Instrumentation for issue #10 (real-glasses measurements). One row per capture plus session
// start statistics. Everything is recorded on the phone and exported as CSV from the
// Diagnostics screen; nothing here is uploaded.
//

import Foundation

struct CaptureMetrics: Codable, Sendable, Identifiable, Equatable {
  /// Event id once known; otherwise a capture-attempt id.
  var id: String
  var source: CaptureSource?
  /// App tapped Capture (nil for shutter-button photos).
  var requestedAt: Date?
  /// First `transferProgressPublisher` tick.
  var firstProgressAt: Date?
  /// `photoDataPublisher` delivered the bytes.
  var bytesAt: Date?
  var bytes: Int?
  var format: ImageFormat?
  var requestedResolution: String?
  var requestedQuality: String?
  var originalPixels: String?
  var pipelineMs: Int?
  var uploadStartedAt: Date?
  var acceptedAt: Date?
  var inGraphAt: Date?
  /// `active` | `inactive` | `background` at the moment the bytes arrived. Answers #10's first question.
  var appStateAtArrival: String?
  var glassesBattery: Int?
  var phoneBattery: Int?
  var error: String?

  init(id: String) { self.id = id }

  var captureToBytesMs: Int? {
    guard let requestedAt, let bytesAt else { return nil }
    return Int(bytesAt.timeIntervalSince(requestedAt) * 1000)
  }
  var uploadToAcceptedMs: Int? {
    guard let uploadStartedAt, let acceptedAt else { return nil }
    return Int(acceptedAt.timeIntervalSince(uploadStartedAt) * 1000)
  }
  var bytesToInGraphMs: Int? {
    guard let bytesAt, let inGraphAt else { return nil }
    return Int(inGraphAt.timeIntervalSince(bytesAt) * 1000)
  }
}

struct SessionMetrics: Codable, Sendable, Equatable {
  var sessionStartAttempts = 0
  var sessionStartFailures = 0
  var lastSessionStartMs: Int?
  var photoStartAttempts = 0
  var photoStartFailures = 0
  var lastPhotoStartMs: Int?
  var shutterPhotosWhileBackgrounded = 0
  var shutterPhotosWhileForeground = 0
  var lastSessionError: String?
}

struct BatterySample: Codable, Sendable, Equatable, Identifiable {
  var id: Date { at }
  let at: Date
  let glassesLevel: Int?
  let phoneLevel: Int?
}
