//
// DiagnosticsStore.swift
// Shift Memory
//
// The instrumentation behind issue #10 (real-glasses measurements). The capture path opens a row
// with `begin`, fills it in with `update` as a photo goes from request to bytes to `in_graph`, and
// `rename`s it once the event id exists; the glasses controller notes session starts, photo starts
// and shutter arrivals; every capture samples both batteries. The store keeps the last 500 rows and
// 2000 samples in one JSON file under Application Support, saves half a second after the last
// change, and computes the summary MEASUREMENTS.md asks for. Nothing here is uploaded: the numbers
// leave the phone as the CSV or JSON the Diagnostics screen hands to the share sheet.
//

import Foundation
import Observation

// MARK: - Store

@MainActor
@Observable
final class DiagnosticsStore {
  static let captureCap = 500
  static let batteryCap = 2000
  static let batteryDedupeSeconds: TimeInterval = 60
  static let fileName = "diagnostics.json"

  /// Newest first.
  private(set) var captures: [CaptureMetrics] = []
  private(set) var session = SessionMetrics()
  /// Oldest first.
  private(set) var battery: [BatterySample] = []
  /// Why the last save failed, for the Diagnostics screen; nil while saves succeed.
  private(set) var lastSaveError: String?

  /// Recomputed on every read: 500 rows is cheap, and it keeps the rows the only source of truth.
  var summary: DiagnosticsSummary {
    DiagnosticsSummary(captures: captures, session: session, battery: battery)
  }

  private let file: DiagnosticsFile
  private let saveDelay: Duration
  private let now: () -> Date
  @ObservationIgnored private var saveTask: Task<Void, Never>?
  @ObservationIgnored private var saveSequence = 0

  /// `directory` is normally `DiagnosticsStore.defaultDirectory()`. The load is synchronous on
  /// purpose: the file is a few hundred KB at most and read once at launch, so callers get a usable
  /// store the moment it exists. Saves are debounced and run off the main actor. `saveDelay` and
  /// `now` exist for tests.
  init(directory: URL, saveDelay: Duration = .milliseconds(500), now: @escaping () -> Date = Date.init) {
    let url = directory.appendingPathComponent(Self.fileName, isDirectory: false)
    file = DiagnosticsFile(url: url)
    self.saveDelay = saveDelay
    self.now = now
    if let saved = DiagnosticsFile.read(url) {
      captures = Array(saved.captures.prefix(Self.captureCap))
      session = saved.session
      battery = Array(saved.battery.suffix(Self.batteryCap))
    }
  }

  /// Application Support/Diagnostics; created on the first save.
  static func defaultDirectory(fileManager: FileManager = .default) -> URL {
    let base = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? fileManager.temporaryDirectory
    return base.appendingPathComponent("Diagnostics", isDirectory: true)
  }

  // MARK: Captures

  /// Opens the row for one capture attempt. A known id returns its existing row untouched, so a
  /// retried call cannot produce a duplicate.
  @discardableResult
  func begin(id: String, source: CaptureSource?) -> CaptureMetrics {
    if let existing = captures.first(where: { $0.id == id }) { return existing }
    var row = CaptureMetrics(id: id)
    row.source = source
    captures.insert(row, at: 0)
    if captures.count > Self.captureCap { captures.removeLast(captures.count - Self.captureCap) }
    scheduleSave()
    return row
  }

  /// No-op when the id is unknown (for example a row that was already dropped by the cap).
  func update(id: String, _ mutate: (inout CaptureMetrics) -> Void) {
    guard let i = captures.firstIndex(where: { $0.id == id }) else { return }
    mutate(&captures[i])
    scheduleSave()
  }

  /// The capture-attempt id becomes the event id once the pipeline has minted one. The row keeps
  /// its place; a stale row already using `newId` gives way to this one.
  func rename(id: String, to newId: String) {
    guard id != newId, let i = captures.firstIndex(where: { $0.id == id }) else { return }
    captures[i].id = newId
    if let stale = captures.indices.first(where: { $0 != i && captures[$0].id == newId }) {
      captures.remove(at: stale)
    }
    scheduleSave()
  }

  // MARK: Battery

  /// Appends a sample unless it repeats the previous one within a minute; nothing is recorded when
  /// both levels are unknown.
  func recordBattery(glasses: Int?, phone: Int?) {
    guard glasses != nil || phone != nil else { return }
    let at = now()
    if let last = battery.last,
       last.glassesLevel == glasses, last.phoneLevel == phone,
       at.timeIntervalSince(last.at) < Self.batteryDedupeSeconds {
      return
    }
    battery.append(BatterySample(at: at, glassesLevel: glasses, phoneLevel: phone))
    if battery.count > Self.batteryCap { battery.removeFirst(battery.count - Self.batteryCap) }
    scheduleSave()
  }

  // MARK: Session

  func noteSessionStart(success: Bool, ms: Int?, error: String?) {
    session.sessionStartAttempts += 1
    if let ms { session.lastSessionStartMs = ms }
    if !success {
      session.sessionStartFailures += 1
      session.lastSessionError = error ?? "unknown"
    }
    scheduleSave()
  }

  func notePhotoStart(success: Bool, ms: Int?) {
    session.photoStartAttempts += 1
    if let ms { session.lastPhotoStartMs = ms }
    if !success { session.photoStartFailures += 1 }
    scheduleSave()
  }

  /// Answers #10's first question; `foreground` is whether the app was active when the bytes arrived.
  func noteShutterArrival(foreground: Bool) {
    if foreground {
      session.shutterPhotosWhileForeground += 1
    } else {
      session.shutterPhotosWhileBackgrounded += 1
    }
    scheduleSave()
  }

  // MARK: Export

  /// RFC 4180 CSV in the temporary directory, one line per capture, newest first, columns in
  /// `DiagnosticsCSV.columns` order. Hand the URL to a share sheet.
  func exportCSV() throws -> URL {
    let url = exportURL(pathExtension: "csv")
    try Data(DiagnosticsCSV.render(captures).utf8).write(to: url, options: .atomic)
    return url
  }

  /// The rows, counters and battery samples plus the computed summary, so the file reads on its own.
  func exportJSON() throws -> URL {
    let url = exportURL(pathExtension: "json")
    let export = DiagnosticsExport(
      exportedAt: now(), summary: summary, captures: captures, session: session, battery: battery)
    try DiagnosticsJSON.encoder(pretty: true).encode(export).write(to: url, options: .atomic)
    return url
  }

  private func exportURL(pathExtension: String) -> URL {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyyMMdd-HHmm"
    return FileManager.default.temporaryDirectory
      .appendingPathComponent("shift-memory-diagnostics-\(f.string(from: now())).\(pathExtension)")
  }

  // MARK: Lifecycle

  /// Clears every row and counter and writes the empty state.
  func reset() {
    captures = []
    session = SessionMetrics()
    battery = []
    scheduleSave()
  }

  /// Writes any pending change now. The composition root calls it when the app goes to the
  /// background, since a debounced save may still be waiting; tests use it for determinism.
  func flush() async {
    saveTask?.cancel()
    saveTask = nil
    await persist()
  }

  // MARK: - Persistence

  private func scheduleSave() {
    saveTask?.cancel()
    saveTask = Task { [saveDelay] in
      try? await Task.sleep(for: saveDelay)
      guard !Task.isCancelled else { return }
      await persist()
    }
  }

  private func persist() async {
    saveSequence += 1
    let snapshot = DiagnosticsSnapshot(captures: captures, session: session, battery: battery)
    do {
      try await file.write(snapshot, sequence: saveSequence)
      lastSaveError = nil
    } catch {
      lastSaveError = String(describing: error)
    }
  }
}

// MARK: - File

/// The on-disk shape: exactly the store's three collections.
struct DiagnosticsSnapshot: Codable, Sendable, Equatable {
  var captures: [CaptureMetrics]
  var session: SessionMetrics
  var battery: [BatterySample]
}

/// What `exportJSON()` writes.
struct DiagnosticsExport: Codable, Sendable {
  var exportedAt: Date
  var summary: DiagnosticsSummary
  var captures: [CaptureMetrics]
  var session: SessionMetrics
  var battery: [BatterySample]
}

/// Owns the JSON file so encoding and disk writes never run on the main actor.
actor DiagnosticsFile {
  let url: URL
  private var lastSequence = 0

  init(url: URL) { self.url = url }

  /// Writes `snapshot` unless a newer one has already been written; a flush racing a debounced save
  /// can otherwise land the older state last.
  func write(_ snapshot: DiagnosticsSnapshot, sequence: Int) throws {
    guard sequence > lastSequence else { return }
    lastSequence = sequence
    let data = try DiagnosticsJSON.encoder().encode(snapshot)
    try FileManager.default.createDirectory(
      at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    try data.write(to: url, options: .atomic)
  }

  /// Synchronous so the store can load in `init`. A missing or unreadable file means an empty store.
  nonisolated static func read(_ url: URL) -> DiagnosticsSnapshot? {
    guard let data = try? Data(contentsOf: url) else { return nil }
    return try? DiagnosticsJSON.decoder().decode(DiagnosticsSnapshot.self, from: data)
  }
}

enum DiagnosticsJSON {
  static func encoder(pretty: Bool = false) -> JSONEncoder {
    let encoder = JSONEncoder()
    encoder.outputFormatting = pretty ? [.prettyPrinted, .sortedKeys] : [.sortedKeys]
    encoder.dateEncodingStrategy = .custom { date, encoder in
      var container = encoder.singleValueContainer()
      try container.encode(ISO8601Stamp.string(date))
    }
    return encoder
  }

  static func decoder() -> JSONDecoder {
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .custom { decoder in
      let text = try decoder.singleValueContainer().decode(String.self)
      guard let date = ISO8601Stamp.date(text) else {
        throw DecodingError.dataCorrupted(
          .init(codingPath: decoder.codingPath, debugDescription: "Not an ISO-8601 date: \(text)"))
      }
      return date
    }
    return decoder
  }
}

/// ISO-8601 in UTC with milliseconds, e.g. `2026-11-08T20:41:03.120Z`, for the JSON file and the CSV.
/// Parsing also accepts stamps without fractional seconds.
enum ISO8601Stamp {
  private static let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
  private static let whole = Date.ISO8601FormatStyle()

  static func string(_ date: Date) -> String { date.formatted(fractional) }

  static func date(_ text: String) -> Date? {
    (try? fractional.parse(text)) ?? (try? whole.parse(text))
  }
}

// MARK: - CSV

/// One capture per line, RFC 4180: CRLF line ends, a field is quoted when it contains a comma, a
/// quote or a line break, and quotes inside are doubled. The column order is fixed so a sheet built
/// on one export keeps working on the next.
enum DiagnosticsCSV {
  static let columns = [
    "id", "source", "requestedAt", "firstProgressAt", "bytesAt", "captureToBytesMs", "bytes", "format",
    "requestedResolution", "requestedQuality", "originalPixels", "pipelineMs", "uploadStartedAt",
    "acceptedAt", "uploadToAcceptedMs", "inGraphAt", "bytesToInGraphMs", "appStateAtArrival",
    "glassesBattery", "phoneBattery", "error",
  ]
  static var header: String { columns.joined(separator: ",") }
  private static let needsQuoting = CharacterSet(charactersIn: ",\"\r\n")

  static func render(_ rows: [CaptureMetrics]) -> String {
    ([header] + rows.map { line($0) }).joined(separator: "\r\n") + "\r\n"
  }

  static func line(_ m: CaptureMetrics) -> String {
    let fields: [String?] = [
      m.id, m.source?.rawValue, date(m.requestedAt), date(m.firstProgressAt), date(m.bytesAt),
      int(m.captureToBytesMs), int(m.bytes), m.format?.rawValue, m.requestedResolution,
      m.requestedQuality, m.originalPixels, int(m.pipelineMs), date(m.uploadStartedAt),
      date(m.acceptedAt), int(m.uploadToAcceptedMs), date(m.inGraphAt), int(m.bytesToInGraphMs),
      m.appStateAtArrival, int(m.glassesBattery), int(m.phoneBattery), m.error,
    ]
    return fields.map { quote($0 ?? "") }.joined(separator: ",")
  }

  static func quote(_ field: String) -> String {
    guard field.rangeOfCharacter(from: needsQuoting) != nil else { return field }
    return "\"" + field.replacingOccurrences(of: "\"", with: "\"\"") + "\""
  }

  private static func date(_ date: Date?) -> String? { date.map(ISO8601Stamp.string) }
  private static func int(_ value: Int?) -> String? { value.map { String($0) } }
}

// MARK: - Summary

struct LatencyStats: Codable, Sendable, Equatable {
  var count: Int
  var medianMs: Int
  var p90Ms: Int
}

/// The numbers MEASUREMENTS.md asks for, derived from the rows.
struct DiagnosticsSummary: Codable, Sendable, Equatable {
  var captureCount: Int
  /// Keyed by `CaptureSource.rawValue`; `unknown` when a row never learned its source.
  var bySource: [String: Int]
  /// Keyed by `ImageFormat.rawValue`; `unknown` until the bytes were sniffed.
  var byFormat: [String: Int]
  /// `sdk_capture` rows with a request time and bytes, keyed `"<resolution>/<quality>"`, e.g. `full/high`.
  var captureToBytesBySetting: [String: LatencyStats]
  var uploadToAcceptedMedianMs: Int?
  var bytesToInGraphMedianMs: Int?
  /// `sessionStartFailures / sessionStartAttempts`; nil before the first attempt.
  var sessionStartFailureRate: Double?
  var photoStartFailureRate: Double?
  var shutterBackgrounded: Int
  var shutterForeground: Int
  /// Percent points per hour the glasses lose, from a least-squares line through their levels, sign
  /// flipped so draining reads positive. nil until the samples span 10 minutes and two levels.
  var glassesDrainPerHour: Double?

  init(captures: [CaptureMetrics], session: SessionMetrics, battery: [BatterySample]) {
    captureCount = captures.count
    bySource = Dictionary(captures.map { ($0.source?.rawValue ?? "unknown", 1) }, uniquingKeysWith: +)
    byFormat = Dictionary(captures.map { ($0.format?.rawValue ?? "unknown", 1) }, uniquingKeysWith: +)

    var latencies: [String: [Int]] = [:]
    for m in captures where m.source == .sdkCapture {
      guard let ms = m.captureToBytesMs else { continue }
      latencies["\(m.requestedResolution ?? "unknown")/\(m.requestedQuality ?? "unknown")", default: []].append(ms)
    }
    captureToBytesBySetting = latencies.compactMapValues { values in
      guard let median = DiagnosticsStats.median(values),
            let p90 = DiagnosticsStats.percentile(values, 0.9) else { return nil }
      return LatencyStats(count: values.count, medianMs: median, p90Ms: p90)
    }

    uploadToAcceptedMedianMs = DiagnosticsStats.median(captures.compactMap(\.uploadToAcceptedMs))
    bytesToInGraphMedianMs = DiagnosticsStats.median(captures.compactMap(\.bytesToInGraphMs))
    sessionStartFailureRate = DiagnosticsStats.rate(session.sessionStartFailures, of: session.sessionStartAttempts)
    photoStartFailureRate = DiagnosticsStats.rate(session.photoStartFailures, of: session.photoStartAttempts)
    shutterBackgrounded = session.shutterPhotosWhileBackgrounded
    shutterForeground = session.shutterPhotosWhileForeground
    glassesDrainPerHour = DiagnosticsStats.drainPerHour(
      battery.compactMap { sample in sample.glassesLevel.map { (at: sample.at, level: $0) } })
  }
}

// MARK: - Statistics

/// Small pure helpers, kept apart from the store so the tests can pin their definitions.
enum DiagnosticsStats {
  /// The middle value, or the mean of the two middle values for an even count. nil for no values.
  static func median(_ values: [Int]) -> Int? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let mid = sorted.count / 2
    return sorted.count.isMultiple(of: 2) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
  }

  /// Nearest-rank percentile: the value at rank ⌈p·n⌉ of the sorted values, so p90 of ten values
  /// is the ninth. `p` is 0…1. nil for no values.
  static func percentile(_ values: [Int], _ p: Double) -> Int? {
    guard !values.isEmpty else { return nil }
    let sorted = values.sorted()
    let rank = Int((p * Double(sorted.count)).rounded(.up))
    return sorted[min(max(rank, 1), sorted.count) - 1]
  }

  /// Failures over attempts; nil before the first attempt.
  static func rate(_ failures: Int, of attempts: Int) -> Double? {
    attempts > 0 ? Double(failures) / Double(attempts) : nil
  }

  /// Least-squares slope of `value` against time, in value units per hour. nil with fewer than two
  /// points or no spread in time.
  static func linearSlopePerHour(_ points: [(at: Date, value: Double)]) -> Double? {
    guard points.count >= 2, let first = points.map({ $0.at }).min() else { return nil }
    let xs = points.map { $0.at.timeIntervalSince(first) / 3600 }
    let ys = points.map { $0.value }
    let xMean = xs.reduce(0, +) / Double(xs.count)
    let yMean = ys.reduce(0, +) / Double(ys.count)
    var sxx = 0.0
    var sxy = 0.0
    for (x, y) in zip(xs, ys) {
      sxx += (x - xMean) * (x - xMean)
      sxy += (x - xMean) * (y - yMean)
    }
    guard sxx > 0 else { return nil }
    return sxy / sxx
  }

  /// Battery drain in percent points per hour, positive while draining. Needs samples spanning at
  /// least `minimumSpan` with two distinct levels: a flat line that short is "no data yet", not zero.
  static func drainPerHour(_ samples: [(at: Date, level: Int)], minimumSpan: TimeInterval = 600) -> Double? {
    guard let first = samples.map({ $0.at }).min(), let last = samples.map({ $0.at }).max(),
          last.timeIntervalSince(first) >= minimumSpan,
          Set(samples.map { $0.level }).count >= 2,
          let slope = linearSlopePerHour(samples.map { (at: $0.at, value: Double($0.level)) })
    else { return nil }
    return -slope
  }
}
