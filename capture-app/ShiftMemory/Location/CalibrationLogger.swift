//
// CalibrationLogger.swift
// Shift Memory
//
// One CSV row per second while a shift is live, at `Application Support/calibration.csv`, so a
// walk through the building yields the data to tune floor detection (issue #19): the barometer,
// the pedometer's floor count, the motion activity, the GPS fix, the Wi-Fi access point, the floor
// the fusion currently outputs and its last decision, and the note the wearer typed on a photo
// (the ground truth: "CAL L1 east stairs"). Appended through FileHandle like TrackStore; the
// header is written when the file is created. Pull it from the phone with
//   xcrun devicectl device copy from --device <udid> --domain-type appDataContainer \
//     --domain-identifier com.edwardkim.hackutd.shiftmemory \
//     --source "Library/Application Support/calibration.csv" --destination calibration.csv
// Nothing here is uploaded.
//

import Foundation
import NetworkExtension

@MainActor
final class CalibrationLogger {
  struct Row: Sendable {
    var t = Date()
    var shiftId = ""
    var relativeAltitudeM: Double?
    var pressureKPa: Double?
    var floorsAscended: Int?
    var floorsDescended: Int?
    var activity: String?
    var activityConfidence: String?
    var fix: LocationFix?
    var bssid: String?
    var ssid: String?
    var floor: Int?
    var baselineOffsetM: Double?
    var decision: String?
    var note: String?
  }

  nonisolated static let header = "t,shift_id,rel_alt_m,pressure_kpa,floors_up,floors_down,activity,activity_conf,lat,lon,h_acc_m,alt_m,v_acc_m,fix_age_s,bssid,ssid,floor,baseline_m,decision,note"
  nonisolated static let interval: Duration = .seconds(1)

  nonisolated static var url: URL {
    let support = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
      ?? FileManager.default.temporaryDirectory
    return support.appending(path: "calibration.csv")
  }

  /// Fills everything but the Wi-Fi and the note; set by the composition root.
  var sample: (() -> Row)?

  private let log: (String) -> Void
  private var task: Task<Void, Never>?
  private var rows = 0
  private var pendingNote: String?
  private var wifi: (bssid: String?, ssid: String?) = (nil, nil)
  private static let writer = DispatchQueue(label: "shiftmemory.calibration", qos: .utility)

  init(log: @escaping (String) -> Void) {
    self.log = log
  }

  var isRunning: Bool { task != nil }

  func start() {
    guard task == nil else { return }
    rows = 0
    log("calibration log started: \(Self.url.path(percentEncoded: false))")
    task = Task { [weak self] in
      while !Task.isCancelled {
        self?.tick()
        try? await Task.sleep(for: Self.interval)
      }
    }
  }

  func stop() {
    guard let task else { return }
    task.cancel()
    self.task = nil
    log("calibration log stopped after \(rows) rows")
  }

  /// A note the wearer typed on a photo; it lands in the next row.
  func note(_ text: String) {
    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return }
    pendingNote = trimmed
    log("note for calibration: \(trimmed)")
  }

  private func tick() {
    guard var row = sample?() else { return }
    row.bssid = wifi.bssid
    row.ssid = wifi.ssid
        row.note = pendingNote
    pendingNote = nil
    rows += 1
    let line = Self.line(row)
    Self.writer.async { Self.append(line) }
    refreshWifi()
  }

  /// The current access point (needs the wifi-info entitlement and precise location, both granted).
  private func refreshWifi() {
    NEHotspotNetwork.fetchCurrent { [weak self] network in
      let bssid = network?.bssid
      let ssid = network?.ssid
      Task { @MainActor [weak self] in self?.wifi = (bssid, ssid) }
    }
  }

  // MARK: - CSV

  nonisolated static func line(_ r: Row) -> String {
    let fixAge = r.fix.map { r.t.timeIntervalSince($0.t) }
    let fields: [String] = [
      r.t.formatted(.iso8601.time(includingFractionalSeconds: true)),
      r.shiftId,
      number(r.relativeAltitudeM, 2),
      number(r.pressureKPa, 4),
      r.floorsAscended.map(String.init) ?? "",
      r.floorsDescended.map(String.init) ?? "",
      r.activity ?? "",
      r.activityConfidence ?? "",
      number(r.fix?.lat, 7),
      number(r.fix?.lon, 7),
      number(r.fix?.accuracyM, 1),
      number(r.fix?.altM, 1),
      number(r.fix?.altAccuracyM, 1),
      number(fixAge, 1),
      r.bssid ?? "",
      r.ssid ?? "",
      r.floor.map(String.init) ?? "",
      number(r.baselineOffsetM, 2),
      r.decision ?? "",
      r.note ?? "",
    ]
    return fields.map(escape).joined(separator: ",") + "\n"
  }

  nonisolated static func number(_ v: Double?, _ places: Int) -> String {
    guard let v, v.isFinite else { return "" }
    return String(format: "%.\(places)f", v)
  }

  /// RFC 4180: quote when the field has a comma, quote, or newline; double the quotes.
  nonisolated static func escape(_ s: String) -> String {
    guard s.contains(where: { $0 == "," || $0 == "\"" || $0 == "\n" || $0 == "\r" }) else { return s }
    return "\"" + s.replacingOccurrences(of: "\"", with: "\"\"") + "\""
  }

  private nonisolated static func append(_ line: String) {
    let url = url
    let path = url.path(percentEncoded: false)
    let fm = FileManager.default
    do {
      if !fm.fileExists(atPath: path) {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard fm.createFile(atPath: path, contents: Data((header + "\n").utf8),
                            attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication]) else { return }
      }
      let handle = try FileHandle(forWritingTo: url)
      defer { try? handle.close() }
      _ = try handle.seekToEnd()
      try handle.write(contentsOf: Data(line.utf8))
    } catch {
      NSLog("[Calibration] append failed: %@", error.localizedDescription)
    }
  }
}
