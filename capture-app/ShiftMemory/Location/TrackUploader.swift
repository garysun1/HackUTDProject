//
// TrackUploader.swift
// Shift Memory
//
// Drains the TrackStore into `ingest_track(track_json)` (contract v3.1, issue #20) so the console
// on the computer can draw the wearer's walk next to the photos. One long-lived loop wakes every
// 30 s (or on `kick()`), feature-detects `ingest_track` in the module schema (at most every 5 min
// while the module lacks it, every tick while the schema is unreachable; the phone keeps buffering
// meanwhile), then
// sends batches of <= 200 points one at a time until the shift's backlog is empty or a call fails.
// Retryable failures back off 5 s → 5 min; a rejected token or payload stops sending until the next
// `kick()` and shows in `lastError`. The module is idempotent on (device_id, t), so a batch resent
// after a lost reply only comes back as duplicates.
//

import Foundation
import Observation

@MainActor
@Observable
final class TrackUploader {
  enum Support: Equatable, Sendable {
    case unknown
    case supported
    case unsupported
    case unreachable(String)
  }

  /// Who is sending. Nil from the provider means the backend or token is not configured: do nothing.
  struct Context: Sendable, Equatable {
    let deviceId: String
    let ingestToken: String
    let appVersion: String
  }

  private(set) var support: Support = .unknown
  private(set) var pending: Int = 0
  /// Points and marks the module acknowledged (accepted + duplicates) since launch.
  private(set) var sent: Int = 0
  private(set) var lastSentAt: Date?
  private(set) var lastError: String?

  nonisolated static let interval: Duration = .seconds(30)
  nonisolated static let schemaRecheck: TimeInterval = 5 * 60
  /// Below `interval`, so every tick re-checks after a failed schema fetch.
  nonisolated static let unreachableRecheck: TimeInterval = 25
  nonisolated static let initialBackoff: TimeInterval = 5
  nonisolated static let maxBackoff: TimeInterval = 5 * 60
  nonisolated static let maxPointsPerBatch = 200
  nonisolated static let procedureName = "ingest_track"

  @ObservationIgnored private let store: TrackStore
  @ObservationIgnored private let client: IngestClient
  @ObservationIgnored private let context: @MainActor () -> Context?
  @ObservationIgnored private let log: (String) -> Void

  @ObservationIgnored private var loop: Task<Void, Never>?
  @ObservationIgnored private var sleeper: Task<Void, Never>?
  /// A kick that arrived while a cycle was running: skip the next sleep.
  @ObservationIgnored private var kicked = false
  @ObservationIgnored private var inFlight = false
  @ObservationIgnored private var lastSchemaCheck: Date?
  @ObservationIgnored private var retryAt: Date?
  @ObservationIgnored private var failures = 0
  /// Set by a non-retryable error; cleared by `kick()`.
  @ObservationIgnored private var halted = false

  init(
    store: TrackStore,
    client: IngestClient,
    context: @escaping @MainActor () -> Context?,
    log: @escaping (String) -> Void
  ) {
    self.store = store
    self.client = client
    self.context = context
    self.log = log
  }

  // MARK: - Lifecycle

  /// Starts the loop. Idempotent.
  func start() {
    guard loop == nil else { return }
    loop = Task { @MainActor [weak self] in
      while !Task.isCancelled {
        guard let self else { return }
        await self.cycle()
        if Task.isCancelled { return }
        await self.waitForNextCycle()
      }
    }
  }

  /// Network back, shift ended, token or endpoint changed: run now, re-check the schema, forget
  /// any backoff, and resume after a non-retryable error.
  func kick() {
    lastSchemaCheck = nil
    retryAt = nil
    failures = 0
    halted = false
    kicked = true
    sleeper?.cancel()
  }

  func stop() {
    loop?.cancel()
    loop = nil
    sleeper?.cancel()
    sleeper = nil
  }

  private func waitForNextCycle() async {
    if kicked {
      kicked = false
      return
    }
    var delay = Self.interval
    if let retryAt, !halted {
      let wait = retryAt.timeIntervalSinceNow
      if wait < 30 { delay = .milliseconds(max(100, Int(wait * 1000))) }
    }
    let nap = Task { @MainActor in _ = try? await Task.sleep(for: delay) }
    sleeper = nap
    await nap.value
    sleeper = nil
    kicked = false
  }

  // MARK: - One cycle

  private func cycle() async {
    guard !inFlight else { return }
    inFlight = true
    defer { inFlight = false }

    await refreshPending()
    guard context() != nil else { return }
    if support != .supported { await checkSchema() }
    guard support == .supported, !halted else { return }
    if let retryAt, retryAt > Date() { return }
    await drain()
  }

  private func refreshPending() async {
    pending = await store.pendingCount()
  }

  private func checkSchema() async {
    // A module without `ingest_track` is asked again every 5 min; a failed check (no network, no
    // backend yet) is retried on the next tick so a launch without signal does not wait 5 min.
    var recheck = Self.schemaRecheck
    if case .unreachable = support { recheck = Self.unreachableRecheck }
    if let lastSchemaCheck, Date().timeIntervalSince(lastSchemaCheck) < recheck { return }
    lastSchemaCheck = Date()
    let next: Support
    do {
      let names = try await client.exportedCallables()
      next = names.contains(Self.procedureName) ? .supported : .unsupported
    } catch {
      next = .unreachable(error.userMessage)
    }
    setSupport(next)
  }

  private func setSupport(_ next: Support) {
    guard next != support else { return }
    switch next {
    case .supported: log("\(Self.procedureName) supported by the module; uploading \(pending) pending item(s)")
    case .unsupported: log("module does not export \(Self.procedureName) yet; buffering \(pending) item(s) on the phone")
    case .unreachable(let why): log("schema check failed: \(why)")
    case .unknown: break
    }
    support = next
  }

  /// Sends batches one at a time until nothing is pending or a call fails.
  private func drain() async {
    while !Task.isCancelled {
      guard let context = context() else { return }
      guard let batch = await store.nextBatch(maxPoints: Self.maxPointsPerBatch), !batch.isEmpty else { break }
      let body = Self.trackJSON(context: context, batch: batch)
      let started = Date()
      do {
        let reply = try await client.ingestTrack(trackJSON: body)
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        await store.confirm(batch)
        sent += reply.accepted + reply.duplicates
        lastSentAt = Date()
        lastError = nil
        failures = 0
        retryAt = nil
        log("track batch shift \(batch.shiftId.prefix(8)): \(batch.points.count) point(s), \(batch.marks.count) mark(s) → accepted \(reply.accepted), duplicates \(reply.duplicates) in \(ms)ms")
        await refreshPending()
      } catch {
        await handle(error, batch: batch)
        await refreshPending()
        return
      }
    }
  }

  private func handle(_ error: IngestError, batch: TrackBatch) async {
    let message = error.userMessage
    lastError = message
    if case .http(let status, _) = error, status == 404 {
      // The procedure disappeared (module republished without it): back to buffering.
      log("track batch shift \(batch.shiftId.prefix(8)) got HTTP 404; re-checking the schema")
      lastSchemaCheck = nil
      setSupport(.unsupported)
      return
    }
    if case .notConfigured = error {
      // Settings will change; try again on the next tick without a hard stop.
      log("track upload skipped: \(message)")
      return
    }
    if error.isRetryable {
      failures += 1
      let backoff = Self.backoff(failures: failures)
      retryAt = Date().addingTimeInterval(backoff)
      log("track batch shift \(batch.shiftId.prefix(8)) failed (\(batch.points.count) point(s)); retry in \(Int(backoff))s: \(message)")
    } else if case .badRequest = error {
      // The module rejected this batch's content (not the token): set it aside so later batches still
      // go. It stays in the shift history and in the GeoJSON export.
      await store.confirm(batch)
      failures = 0
      log("track batch shift \(batch.shiftId.prefix(8)) rejected (\(batch.points.count) point(s)), skipped: \(message)")
    } else {
      halted = true
      log("track upload stopped until kick: \(message)")
    }
  }

  /// 5 s, 10 s, 20 s … capped at 5 min.
  nonisolated static func backoff(failures: Int) -> TimeInterval {
    let exponent = Double(max(0, min(failures - 1, 16)))
    return min(maxBackoff, initialBackoff * pow(2, exponent))
  }

  // MARK: - Body

  /// The `track_json` argument, top-level keys in contract order: device_id, shift_id,
  /// ingest_token, app_version, points, marks. Every `t` carries the phone's UTC offset at that
  /// instant. Point keys follow the contract (t, lat, lon, accuracy_m, alt_m, floor, speed_mps,
  /// course_deg) and nothing else: `alt_accuracy_m` and `age_ms` belong to event locations only.
  nonisolated static func trackJSON(context: Context, batch: TrackBatch, timeZone: TimeZone = .current) -> String {
    let points = batch.points.map { point -> String in
      let object = point.fix.contractObject(offsetSeconds: timeZone.secondsFromGMT(for: point.fix.t))
      // Only the contract's point keys: `contractObject` also carries `alt_accuracy_m` (event-only).
      return TrackJSONText.object(object.filter { pointKeyOrder.contains($0.key) }, order: pointKeyOrder)
    }
    let marks = batch.marks.map { mark -> String in
      TrackJSONText.object(
        ["t": EventEnvelope.iso8601(mark.t, offsetSeconds: timeZone.secondsFromGMT(for: mark.t)), "kind": mark.kind],
        order: ["t", "kind"]
      )
    }
    let pairs: [(String, String)] = [
      ("device_id", TrackJSONText.string(context.deviceId)),
      ("shift_id", TrackJSONText.string(batch.shiftId)),
      ("ingest_token", TrackJSONText.string(context.ingestToken)),
      ("app_version", TrackJSONText.string(context.appVersion)),
      ("points", "[" + points.joined(separator: ",") + "]"),
      ("marks", "[" + marks.joined(separator: ",") + "]"),
    ]
    return "{" + pairs.map { "\(TrackJSONText.string($0.0)):\($0.1)" }.joined(separator: ",") + "}"
  }

  nonisolated static let pointKeyOrder = [
    "t", "lat", "lon", "accuracy_m", "alt_m", "floor", "speed_mps", "course_deg",
  ]
}
