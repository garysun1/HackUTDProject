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

@MainActor
@Observable
final class AppConfig {
  // MARK: Backend
  var host: String { didSet { defaults.set(host, forKey: Keys.host) } }
  var database: String { didSet { defaults.set(database, forKey: Keys.database) } }
  var ingestToken: String { didSet { keychain.set(ingestToken, for: Keys.ingestToken) } }

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
  /// Keep the glasses session alive when the app goes to the background (needed to test
  /// shutter-button delivery while backgrounded, issue #10). Off ends the session on background.
  var keepSessionInBackground: Bool { didSet { defaults.set(keepSessionInBackground, forKey: Keys.keepSessionInBackground) } }

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
    cameraRollImportEnabled = defaults.bool(forKey: Keys.cameraRollImportEnabled)
    cameraRollOnlyGlassesPhotos = defaults.object(forKey: Keys.cameraRollOnlyGlassesPhotos) as? Bool ?? true

    let storedDeviceId = defaults.string(forKey: Keys.deviceId) ?? ""
    deviceId = storedDeviceId
    if storedDeviceId.isEmpty {
      deviceId = AppConfig.defaultDeviceId(wearerName: wearerName)
    }
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
