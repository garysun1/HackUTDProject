//
// AppConfig.swift
// Shift Memory
//
// Everything the user can set. Persisted in UserDefaults except the ingest token, which lives in
// the Keychain. First launch seeds from an optional bundled Config.plist (gitignored; see
// Config.example.plist). Views bind to these properties directly.
//

import Foundation
import Observation
import os

/// The backend endpoint as last saved, readable from any thread. The upload queue and ingest client
/// run off the main actor and read it per request; `AppConfig` itself is main-actor isolated.
final class EndpointSnapshot: Sendable {
  private let lock = OSAllocatedUnfairLock(initialState: BackendEndpoint(host: "", database: ""))
  var value: BackendEndpoint { lock.withLock { $0 } }
  func set(_ endpoint: BackendEndpoint) { lock.withLock { $0 = endpoint } }
}

/// A secret as last saved, readable from any thread (the NVIDIA client runs off the main actor).
final class SecretSnapshot: Sendable {
  private let lock = OSAllocatedUnfairLock(initialState: "")
  var value: String { lock.withLock { $0 } }
  func set(_ value: String) { lock.withLock { $0 = value } }
}

@MainActor
@Observable
final class AppConfig {
  // MARK: Backend
  var host: String { didSet { defaults.set(host, forKey: Keys.host); endpointSnapshot.set(endpoint) } }
  var database: String { didSet { defaults.set(database, forKey: Keys.database); endpointSnapshot.set(endpoint) } }
  /// Thread-safe copy of `endpoint` for callers off the main actor (IngestClient).
  let endpointSnapshot = EndpointSnapshot()
  var ingestToken: String {
    didSet {
      keychain.set(ingestToken, for: Keys.ingestToken)
      onIngestTokenChanged?()
    }
  }
  /// Called after every token edit (per keystroke); the app debounces it into a queue retry, so
  /// events rejected with `invalid_token` resend once the right token is in.
  var onIngestTokenChanged: (() -> Void)?

  // MARK: Identity (attribution on every event)
  var wearerName: String { didSet { defaults.set(wearerName, forKey: Keys.wearerName) } }
  /// Stable id for this phone + glasses pair. Gary seeds `demo/wearers.csv` with it.
  var deviceId: String { didSet { defaults.set(deviceId, forKey: Keys.deviceId) } }

  // MARK: Capture
  /// `PhotoResolution` raw value: small | medium | large | full
  var captureResolution: String { didSet { defaults.set(captureResolution, forKey: Keys.captureResolution) } }
  /// `PhotoQuality` raw value: low | medium | high
  var captureQuality: String { didSet { defaults.set(captureQuality, forKey: Keys.captureQuality) } }
  var blurFaces: Bool { didSet { defaults.set(blurFaces, forKey: Keys.blurFaces) } }
  /// Optional label and note attached to the next captured photo (contract `label.name`, `note`).
  var pendingLabel: String = ""
  var pendingNote: String = ""
  /// Prepended to the next photo's note: "Handoff: " for the closing photo, "Re: PDU A (FAULT). "
  /// for a fix photo started from the floor map. Cleared with the other pending fields.
  var pendingNotePrefix: String = ""
  /// Keep the glasses session alive when the app goes to the background (needed to test
  /// shutter-button delivery while backgrounded, issue #10). Off ends the session on background.
  var keepSessionInBackground: Bool { didSet { defaults.set(keepSessionInBackground, forKey: Keys.keepSessionInBackground) } }
  /// Chime on the phone the instant a capture is requested (shutter press or Capture button).
  var shutterSound: Bool { didSet { defaults.set(shutterSound, forKey: Keys.shutterSound) } }
  /// Listen after each capture and attach what the wearer says as the photo's note.
  var voiceContext: Bool { didSet { defaults.set(voiceContext, forKey: Keys.voiceContext) } }
  /// Record from the glasses' microphone (Bluetooth headset) rather than the phone's.
  var useGlassesMic: Bool { didSet { defaults.set(useGlassesMic, forKey: Keys.useGlassesMic) } }
  /// Show the shift briefing before a shift starts.
  var briefingOnStart: Bool { didSet { defaults.set(briefingOnStart, forKey: Keys.briefingOnStart) } }
  /// Read the briefing aloud by itself and have the wearer repeat the key points back (Nemotron + Magpie
  /// with a key; template script + keyword grade without).
  var spokenBriefingCheck: Bool { didSet { defaults.set(spokenBriefingCheck, forKey: Keys.spokenBriefingCheck) } }
  /// NVIDIA API key for Nemotron (briefing text, grading) and Magpie TTS (the voice). Keychain.
  var nvidiaApiKey: String {
    didSet {
      keychain.set(nvidiaApiKey.isEmpty ? nil : nvidiaApiKey, for: Keys.nvidiaApiKey)
      nvidiaKeySnapshot.set(nvidiaApiKey)
    }
  }
  let nvidiaKeySnapshot = SecretSnapshot()
  var hasNvidiaApiKey: Bool { !nvidiaApiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  /// When this wearer last ended a shift / acknowledged a briefing (local only).
  var lastShiftEndedAt: Date? { didSet { defaults.set(lastShiftEndedAt, forKey: Keys.lastShiftEndedAt) } }
  var lastBriefingAckAt: Date? { didSet { defaults.set(lastBriefingAckAt, forKey: Keys.lastBriefingAckAt) } }
  /// Attach the phone's position to photos and record the walking track during a shift (#19).
  var locationEnabled: Bool { didSet { defaults.set(locationEnabled, forKey: Keys.locationEnabled) } }
  /// The shift in progress on this device (contract v3.1 `shift_id`); nil between shifts. Persisted
  /// so a relaunch mid-shift keeps the same id and resumes the track.
  var activeShiftId: String? { didSet { defaults.set(activeShiftId, forKey: Keys.activeShiftId) } }
  var activeShiftStartedAt: Date? { didSet { defaults.set(activeShiftStartedAt, forKey: Keys.activeShiftStartedAt) } }

  // MARK: Camera-roll import (issue #2)
  var cameraRollImportEnabled: Bool { didSet { defaults.set(cameraRollImportEnabled, forKey: Keys.cameraRollImportEnabled) } }
  var cameraRollOnlyGlassesPhotos: Bool { didSet { defaults.set(cameraRollOnlyGlassesPhotos, forKey: Keys.cameraRollOnlyGlassesPhotos) } }

  // MARK: Derived
  var endpoint: BackendEndpoint { BackendEndpoint(host: host, database: database) }
  var isBackendConfigured: Bool { endpoint.isConfigured }
  var hasIngestToken: Bool { !ingestToken.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  var appVersion: String { EventEnvelope.appVersion }

  private let defaults: UserDefaults
  private let keychain: KeychainStore

  enum Keys {
    static let host = "backend.host"
    static let database = "backend.database"
    static let ingestToken = "ingest_token"
    static let wearerName = "identity.wearerName"
    static let deviceId = "identity.deviceId"
    static let captureResolution = "capture.resolution"
    static let captureQuality = "capture.quality"
    static let blurFaces = "capture.blurFaces"
    static let keepSessionInBackground = "capture.keepSessionInBackground"
    static let shutterSound = "capture.shutterSound"
    static let voiceContext = "capture.voiceContext"
    static let useGlassesMic = "capture.useGlassesMic"
    static let briefingOnStart = "shift.briefingOnStart"
    static let spokenBriefingCheck = "shift.spokenBriefingCheck"
    static let nvidiaApiKey = "nvidia_api_key"
    static let lastShiftEndedAt = "shift.lastShiftEndedAt"
    static let lastBriefingAckAt = "shift.lastBriefingAckAt"
    static let locationEnabled = "location.enabled"
    static let activeShiftId = "shift.activeShiftId"
    static let activeShiftStartedAt = "shift.activeShiftStartedAt"
    static let cameraRollImportEnabled = "import.enabled"
    static let cameraRollOnlyGlassesPhotos = "import.onlyGlassesPhotos"
    static let seeded = "config.seededFromPlist"
  }

  init(defaults: UserDefaults = .standard,
       keychain: KeychainStore = KeychainStore(service: Bundle.main.bundleIdentifier ?? "com.edwardkim.hackutd.shiftmemory"),
       bundledConfig: [String: Any]? = AppConfig.loadBundledConfig()) {
    self.defaults = defaults
    self.keychain = keychain

    // Seed once from Config.plist so a fresh install is ready without typing.
    if !defaults.bool(forKey: Keys.seeded), let seed = bundledConfig {
      if let v = seed["SPACETIME_HOST"] as? String, !v.isEmpty { defaults.set(v, forKey: Keys.host) }
      if let v = seed["SPACETIME_DB_NAME"] as? String, !v.isEmpty { defaults.set(v, forKey: Keys.database) }
      if let v = seed["WEARER_NAME"] as? String, !v.isEmpty { defaults.set(v, forKey: Keys.wearerName) }
      if let v = seed["DEVICE_ID"] as? String, !v.isEmpty { defaults.set(v, forKey: Keys.deviceId) }
      if let v = seed["INGEST_TOKEN"] as? String, !v.isEmpty, keychain.string(for: Keys.ingestToken) == nil {
        keychain.set(v, for: Keys.ingestToken)
      }
      if let v = seed["NVIDIA_API_KEY"] as? String, !v.isEmpty, keychain.string(for: Keys.nvidiaApiKey) == nil {
        keychain.set(v, for: Keys.nvidiaApiKey)
      }
      defaults.set(true, forKey: Keys.seeded)
    }

    host = defaults.string(forKey: Keys.host) ?? "https://maincloud.spacetimedb.com"
    database = defaults.string(forKey: Keys.database) ?? "wm-physical"
    ingestToken = keychain.string(for: Keys.ingestToken) ?? ""
    wearerName = defaults.string(forKey: Keys.wearerName) ?? ""
    captureResolution = defaults.string(forKey: Keys.captureResolution) ?? "full"
    captureQuality = defaults.string(forKey: Keys.captureQuality) ?? "high"
    blurFaces = defaults.object(forKey: Keys.blurFaces) as? Bool ?? true
    keepSessionInBackground = defaults.object(forKey: Keys.keepSessionInBackground) as? Bool ?? true
    shutterSound = defaults.object(forKey: Keys.shutterSound) as? Bool ?? true
    voiceContext = defaults.object(forKey: Keys.voiceContext) as? Bool ?? true
    useGlassesMic = defaults.object(forKey: Keys.useGlassesMic) as? Bool ?? true
    briefingOnStart = defaults.object(forKey: Keys.briefingOnStart) as? Bool ?? true
    spokenBriefingCheck = defaults.object(forKey: Keys.spokenBriefingCheck) as? Bool ?? true
    nvidiaApiKey = keychain.string(for: Keys.nvidiaApiKey) ?? ""
    lastShiftEndedAt = defaults.object(forKey: Keys.lastShiftEndedAt) as? Date
    lastBriefingAckAt = defaults.object(forKey: Keys.lastBriefingAckAt) as? Date
    locationEnabled = defaults.object(forKey: Keys.locationEnabled) as? Bool ?? true
    activeShiftId = defaults.string(forKey: Keys.activeShiftId)
    activeShiftStartedAt = defaults.object(forKey: Keys.activeShiftStartedAt) as? Date
    cameraRollImportEnabled = defaults.bool(forKey: Keys.cameraRollImportEnabled)
    cameraRollOnlyGlassesPhotos = defaults.object(forKey: Keys.cameraRollOnlyGlassesPhotos) as? Bool ?? true

    let storedDeviceId = defaults.string(forKey: Keys.deviceId) ?? ""
    deviceId = storedDeviceId
    if storedDeviceId.isEmpty {
      deviceId = AppConfig.defaultDeviceId(wearerName: wearerName)
    }
    endpointSnapshot.set(endpoint)
    nvidiaKeySnapshot.set(nvidiaApiKey)
  }

  /// `edward-iphone` when a wearer name is known, else `phone-3fa9c2`. Readable ids are what the
  /// console shows until Gary seeds the wearer table.
  static func defaultDeviceId(wearerName: String) -> String {
    let slug = wearerName.lowercased()
      .components(separatedBy: CharacterSet.alphanumerics.inverted)
      .filter { !$0.isEmpty }
      .joined(separator: "-")
    if !slug.isEmpty { return "\(slug)-iphone" }
    return "phone-" + String(UUID().uuidString.lowercased().replacingOccurrences(of: "-", with: "").prefix(6))
  }

  static func loadBundledConfig() -> [String: Any]? {
    guard let url = Bundle.main.url(forResource: "Config", withExtension: "plist"),
          let data = try? Data(contentsOf: url),
          let plist = try? PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any]
    else { return nil }
    return plist
  }
}
