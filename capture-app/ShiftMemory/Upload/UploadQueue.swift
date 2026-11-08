//
// UploadQueue.swift
// Shift Memory
//
// Bounded, disk-backed retry queue in front of `ingest_photo` (docs/CONTRACT.md "Retry queue").
// Each queued event is one JSON file plus one JPEG under `directory/`; the files are the queue, so
// an app kill mid-upload loses nothing and the same `event_id` is retried until the module answers.
// The module deduplicates on `event_id`, so a retry after a lost reply simply comes back `duplicate`.
//
// Retryable failures (no network, 5xx, 429) back off 2s → 60s. Non-retryable ones (invalid token,
// bad request) mark the event `failed` and keep the files; `kick()` after fixing Settings retries them.
// After `accepted`, the queue polls `SELECT status, summary FROM event ...` until the module has
// perceived the photo (`in_graph`) or given up (`failed`).
//

import Foundation
import OSLog

actor UploadQueue {
  struct Configuration: Sendable, Equatable {
    var ingestToken: String
    var appVersion: String
  }

  enum Update: Sendable, Equatable {
    case stage(eventId: String, stage: EventStage, serverT: Date?, error: String?, attempts: Int)
    case polled(eventId: String, status: String, summary: String)
    case depth(pending: Int)
  }

  struct Policy: Sendable {
    var capacity = 200
    var initialBackoff: Duration = .seconds(2)
    var maxBackoff: Duration = .seconds(60)
    var pollInterval: Duration = .seconds(2)
    var pollTimeout: Duration = .seconds(120)
  }

  /// Everything the UI needs to mirror the queue. Single consumer (EventStore).
  nonisolated let updates: AsyncStream<Update>

  private let client: any IngestClientProtocol
  private let directory: URL
  private let configuration: @Sendable () async -> Configuration
  private let policy: Policy
  private let emit: AsyncStream<Update>.Continuation
  private let wake: AsyncStream<Void>
  private let wakeContinuation: AsyncStream<Void>.Continuation
  /// Diagnostic log line in Application Support/debug.log (see `DebugLog`); `Logger` output from this
  /// subsystem never surfaced over `idevicesyslog` on the device, and NSLog arrives redacted.
  private nonisolated func log(_ message: String) { DebugLog.write("UploadQueue", message) }

  private var items: [String: CaptureEvent] = [:]
  private var pollers: [String: Task<Void, Never>] = [:]
  private var worker: Task<Void, Never>?
  private var retryTimer: Task<Void, Never>?

  init(
    client: any IngestClientProtocol,
    directory: URL,
    configuration: @escaping @Sendable () async -> Configuration,
    policy: Policy = Policy()
  ) {
    self.client = client
    self.directory = directory
    self.configuration = configuration
    self.policy = policy
    (updates, emit) = AsyncStream.makeStream(of: Update.self, bufferingPolicy: .unbounded)
    (wake, wakeContinuation) = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
  }

  // MARK: - Public

  var pendingCount: Int { items.count }
  var pendingIds: [String] { ordered().map(\.id) }

  /// Persist the event and its JPEG, then try to send. Oldest events are dropped past `capacity`.
  func enqueue(_ event: CaptureEvent, jpeg: Data) {
    var event = event
    event.stage = .queued
    event.nextAttemptAt = nil
    do {
      try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
      try jpeg.write(to: jpegURL(event.id), options: .atomic)
      try write(event)
    } catch {
      log("enqueue persist failed: \(error.localizedDescription)")
    }
    items[event.id] = event
    enforceCapacity()
    emit.yield(.stage(eventId: event.id, stage: .queued, serverT: nil, error: nil, attempts: event.attempts))
    publishDepth()
    kick()
  }

  /// Load what survived the last run and start the worker. Idempotent.
  func start() {
    guard worker == nil else { return }
    load()
    publishDepth()
    worker = Task { [weak self] in
      guard let self else { return }
      for await _ in wake {
        if Task.isCancelled { break }
        await self.drain()
      }
    }
    kick()
  }

  /// Try everything that is due now (network back, Settings changed, user tapped Retry).
  func kick() {
    for id in items.keys { items[id]?.nextAttemptAt = nil }
    wakeContinuation.yield()
  }

  /// Follow an accepted event until the module perceived it. Safe to call repeatedly.
  func startPolling(eventId: String) {
    guard pollers[eventId] == nil else { return }
    pollers[eventId] = Task { [weak self] in
      guard let self else { return }
      await self.poll(eventId: eventId)
      await self.pollerFinished(eventId)
    }
  }

  func retryFailed() { kick() }

  func remove(eventId: String) {
    items[eventId] = nil
    try? FileManager.default.removeItem(at: jsonURL(eventId))
    try? FileManager.default.removeItem(at: jpegURL(eventId))
    publishDepth()
  }

  // MARK: - Worker

  private func drain() async {
    retryTimer?.cancel()
    retryTimer = nil
    var earliestRetry: Date?
    for event in ordered() {
      if Task.isCancelled { return }
      if let at = event.nextAttemptAt, at > Date() {
        earliestRetry = min(earliestRetry ?? at, at)
        continue
      }
      await send(event)
    }
    for event in ordered() {
      if let at = event.nextAttemptAt, at > Date() { earliestRetry = min(earliestRetry ?? at, at) }
    }
    if let earliestRetry {
      let delay = max(0.1, earliestRetry.timeIntervalSinceNow)
      retryTimer = Task { [weak self] in
        try? await Task.sleep(for: .seconds(delay))
        guard !Task.isCancelled else { return }
        self?.wakeContinuation.yield()
      }
    }
  }

  private func send(_ queued: CaptureEvent) async {
    guard var event = items[queued.id] else { return }
    guard let jpeg = try? Data(contentsOf: jpegURL(event.id)) else {
      log("jpeg missing for \(event.id); dropping")
      finish(event, stage: .failed, serverT: nil, error: "Photo bytes were lost before upload.")
      return
    }
    let config = await configuration()
    event.attempts += 1
    event.stage = .uploading
    items[event.id] = event
    emit.yield(.stage(eventId: event.id, stage: .uploading, serverT: nil, error: nil, attempts: event.attempts))

    let eventJSON = EventEnvelope.json(for: event, ingestToken: config.ingestToken, appVersion: config.appVersion)
    let started = Date()
    do {
      let result = try await client.ingest(eventJSON: eventJSON, photoBase64: jpeg.base64EncodedString())
      let ms = Int(Date().timeIntervalSince(started) * 1000)
      log("ingest \(event.id) → \(result.status) in \(ms)ms after \(event.attempts) attempt(s)")
      let stage = Self.stage(forIngestStatus: result.status)
      finish(event, stage: stage, serverT: result.serverT, error: nil)
      if !stage.isTerminal { startPolling(eventId: event.id) }
    } catch {
      let message = error.userMessage
      if error.isRetryable {
        let backoff = Self.backoff(attempt: event.attempts, policy: policy)
        event.stage = .queued
        event.lastError = message
        event.nextAttemptAt = Date().addingTimeInterval(backoff)
        items[event.id] = event
        try? write(event)
        log("ingest \(event.id) retry in \(Int(backoff))s: \(message)")
        emit.yield(.stage(eventId: event.id, stage: .queued, serverT: nil, error: message, attempts: event.attempts))
      } else {
        // Keep the files: fixing the token in Settings and tapping Retry should resend, not re-shoot.
        event.stage = .failed
        event.lastError = message
        event.nextAttemptAt = .distantFuture
        items[event.id] = event
        try? write(event)
        log("ingest \(event.id) rejected: \(message)")
        emit.yield(.stage(eventId: event.id, stage: .failed, serverT: nil, error: message, attempts: event.attempts))
      }
    }
  }

  private func finish(_ event: CaptureEvent, stage: EventStage, serverT: Date?, error: String?) {
    items[event.id] = nil
    try? FileManager.default.removeItem(at: jsonURL(event.id))
    try? FileManager.default.removeItem(at: jpegURL(event.id))
    emit.yield(.stage(eventId: event.id, stage: stage, serverT: serverT, error: error, attempts: event.attempts))
    publishDepth()
  }

  // MARK: - Polling

  private func poll(eventId: String) async {
    let deadline = ContinuousClock.now + policy.pollTimeout
    while !Task.isCancelled, ContinuousClock.now < deadline {
      try? await Task.sleep(for: policy.pollInterval)
      guard let row = try? await client.status(eventId: eventId) else { continue }
      emit.yield(.polled(eventId: eventId, status: row.status, summary: row.summary))
      if ["in_graph", "failed", "duplicate"].contains(row.status) {
        log("poll \(eventId) → \(row.status): \(row.summary.prefix(120))")
        return
      }
    }
  }

  private func pollerFinished(_ eventId: String) { pollers[eventId] = nil }

  // MARK: - Helpers

  static func stage(forIngestStatus status: String) -> EventStage {
    switch status {
    case "in_graph": .inGraph
    case "duplicate": .duplicate
    case "failed": .failed
    default: .accepted
    }
  }

  static func backoff(attempt: Int, policy: Policy) -> TimeInterval {
    let base = Double(policy.initialBackoff.components.seconds)
    let cap = Double(policy.maxBackoff.components.seconds)
    let raw = base * pow(2, Double(max(0, attempt - 1)))
    return min(cap, raw) * Double.random(in: 0.8...1.2)
  }

  private func ordered() -> [CaptureEvent] {
    items.values.sorted { $0.createdAt < $1.createdAt }
  }

  private func enforceCapacity() {
    let overflow = items.count - policy.capacity
    guard overflow > 0 else { return }
    for event in ordered().prefix(overflow) {
      log("queue full; dropping oldest \(event.id)")
      finish(event, stage: .failed, serverT: nil, error: "Dropped: upload queue was full.")
    }
  }

  private func publishDepth() { emit.yield(.depth(pending: items.count)) }

  private func jsonURL(_ id: String) -> URL { directory.appending(path: "\(id).json") }
  private func jpegURL(_ id: String) -> URL { directory.appending(path: "\(id).jpg") }

  private func write(_ event: CaptureEvent) throws {
    let encoder = JSONEncoder()
    encoder.dateEncodingStrategy = .iso8601
    try encoder.encode(event).write(to: jsonURL(event.id), options: .atomic)
  }

  private func load() {
    guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory.path(percentEncoded: false)) else { return }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    for name in names where name.hasSuffix(".json") {
      let url = directory.appending(path: name)
      guard let data = try? Data(contentsOf: url), var event = try? decoder.decode(CaptureEvent.self, from: data) else {
        try? FileManager.default.removeItem(at: url)
        continue
      }
      guard FileManager.default.fileExists(atPath: jpegURL(event.id).path(percentEncoded: false)) else {
        try? FileManager.default.removeItem(at: url)
        continue
      }
      event.stage = .queued
      event.nextAttemptAt = nil
      items[event.id] = event
    }
  }
}
