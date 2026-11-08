//
// FloorStore.swift
// Shift Memory
//
// The floor map's live model: polls the shared memory every few seconds and diffs each snapshot
// against the previous one, so the map can show the memory being updated rather than just its
// latest state. An alert that flips open → resolved between polls is remembered for 20 s (the tile
// "goes out": red → green check → neutral); an asset that a new event involves is remembered for
// 15 s (a brief accent pulse). The diff is a pure static function so tests need no network.
// A local resolve is overlaid on every later snapshot until the server reports it acked, so a poll
// that was already in flight when the wearer tapped "Mark resolved" cannot relight the tile.
//

import Foundation
import Observation

@MainActor
@Observable
final class FloorStore {
  /// What a tile should show for one asset right now.
  enum TileState: Hashable, Sendable {
    case burning(open: [FloorIssue])
    case extinguished(at: Date)
    case touched
    case idle
  }

  /// What changed between two successive snapshots.
  struct Diff: Equatable, Sendable {
    var resolved: [UInt64: Date] = [:]   // alert_id → when the phone saw it go out
    var touched: [String: Date] = [:]    // asset_id → when the phone saw a new event on it
  }

  static let resolvedLifetime: TimeInterval = 20
  static let touchedLifetime: TimeInterval = 15
  /// How long a local ack is overlaid while waiting for the server to report it.
  static let pendingAckLifetime: TimeInterval = 60

  private(set) var snapshot: FloorSnapshot = .empty
  private(set) var isLoading = false
  private(set) var lastError: String?
  private(set) var recentlyResolved: [UInt64: Date] = [:]
  private(set) var recentlyTouched: [String: Date] = [:]
  /// Issues grouped by the registry asset they sit on (recomputed with each snapshot).
  private(set) var issuesByAsset: [String: [FloorIssue]] = [:]
  /// Issues perception raised on something that is not in the registry; listed but not on the map.
  private(set) var unplacedIssues: [FloorIssue] = []

  @ObservationIgnored private let repository: FloorRepository
  @ObservationIgnored private let log: (String) -> Void
  @ObservationIgnored private var pollTask: Task<Void, Never>?
  @ObservationIgnored private var refreshing = false
  /// alert_id → when this phone acked it; overlaid on snapshots until the server agrees.
  @ObservationIgnored private var pendingAcks: [UInt64: Date] = [:]

  init(repository: FloorRepository, log: @escaping (String) -> Void) {
    self.repository = repository
    self.log = log
  }

  // MARK: - Derived

  var openCount: Int { snapshot.issues.lazy.filter { !$0.isResolved }.count }

  /// Issues resolved in the last 12 hours, the header's "resolved this shift".
  func resolvedThisShiftCount(now: Date = Date()) -> Int {
    let since = now.addingTimeInterval(-12 * 3600)
    // An ack the server stored without a time still counts while the phone remembers seeing it go out.
    return snapshot.issues.lazy.filter { issue in
      issue.isResolved && ((issue.resolvedAt ?? .distantPast) >= since || self.recentlyResolved[issue.id] != nil)
    }.count
  }

  func state(for asset: FloorAsset, now: Date = Date()) -> TileState {
    let issues = issuesByAsset[asset.id] ?? []
    let open = issues.filter { !$0.isResolved }.sorted { $0.at > $1.at }
    if !open.isEmpty { return .burning(open: open) }
    let outAt = issues.compactMap { recentlyResolved[$0.id] }
      .filter { now.timeIntervalSince($0) < Self.resolvedLifetime }.max()
    if let outAt { return .extinguished(at: outAt) }
    if let t = recentlyTouched[asset.id], now.timeIntervalSince(t) < Self.touchedLifetime { return .touched }
    return .idle
  }

  func issues(for asset: FloorAsset) -> [FloorIssue] { issuesByAsset[asset.id] ?? [] }

  // MARK: - Loading

  func refresh() async {
    guard !refreshing else { return }
    refreshing = true
    isLoading = true
    defer { refreshing = false; isLoading = false }
    do {
      let next = try await repository.fetch()
      apply(next)
      lastError = nil
    } catch {
      // Leaving the screen cancels the poll mid-request; that is not an error worth showing.
      if Task.isCancelled { return }
      if lastError != error.userMessage { log("floor: refresh failed: \(error.userMessage)") }
      lastError = error.userMessage
    }
  }

  func startPolling(every interval: Duration = .seconds(4)) {
    pollTask?.cancel()
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        // Hold the store only for the refresh, not across the sleep, so a dropped store is freed.
        guard let store = self else { return }
        await store.refresh()
        store.prune()
        try? await Task.sleep(for: interval)
      }
    }
  }

  func stopPolling() {
    pollTask?.cancel()
    pollTask = nil
  }

  /// `ack_alert`, then mark it resolved locally so the tile goes out at once, then re-read.
  func resolve(_ issue: FloorIssue) async -> Bool {
    do {
      try await repository.resolve(issue)
    } catch {
      log("floor: resolve #\(issue.id) failed: \(error.userMessage)")
      lastError = error.userMessage
      return false
    }
    log("floor: resolved #\(issue.id) \(issue.entityName)")
    let now = Date()
    pendingAcks[issue.id] = now
    recentlyResolved[issue.id] = now
    lastError = nil
    setSnapshot(Self.overlay(snapshot, acked: pendingAcks))
    await refresh()
    return true
  }

  /// Takes a new snapshot, folding what changed since the previous one into the recent maps.
  func apply(_ raw: FloorSnapshot, now: Date = Date()) {
    // Forget local acks the server now reports (or that are too old to still be in flight).
    let serverResolved = Set(raw.issues.lazy.filter(\.isResolved).map(\.id))
    pendingAcks = pendingAcks.filter { !serverResolved.contains($0.key) && now.timeIntervalSince($0.value) < Self.pendingAckLifetime }
    let next = Self.overlay(raw, acked: pendingAcks)
    let diff = Self.diff(previous: snapshot, next: next, now: now)
    recentlyResolved.merge(diff.resolved) { old, _ in old }
    recentlyTouched.merge(diff.touched) { _, new in new }
    setSnapshot(next)
    prune(now: now)
  }

  /// Drops resolved / touched marks older than their lifetimes.
  func prune(now: Date = Date()) {
    let r = recentlyResolved.filter { now.timeIntervalSince($0.value) < Self.resolvedLifetime }
    if r.count != recentlyResolved.count { recentlyResolved = r }
    let t = recentlyTouched.filter { now.timeIntervalSince($0.value) < Self.touchedLifetime }
    if t.count != recentlyTouched.count { recentlyTouched = t }
  }

  private func setSnapshot(_ next: FloorSnapshot) {
    snapshot = next
    var byAsset: [String: [FloorIssue]] = [:]
    var unplaced: [FloorIssue] = []
    for issue in next.issues {
      if let asset = next.asset(forIssue: issue) { byAsset[asset.id, default: []].append(issue) }
      else { unplaced.append(issue) }
    }
    issuesByAsset = byAsset
    unplacedIssues = unplaced.sorted { $0.at > $1.at }
  }

  // MARK: - Diff

  /// `snapshot` with every issue in `acked` marked resolved at its ack time (the optimistic update).
  nonisolated static func overlay(_ snapshot: FloorSnapshot, acked: [UInt64: Date]) -> FloorSnapshot {
    guard !acked.isEmpty else { return snapshot }
    var out = snapshot
    out.issues = out.issues.map { issue in
      guard !issue.isResolved, let at = acked[issue.id] else { return issue }
      return issue.resolved(at: at)
    }
    return out
  }

  /// Alerts that went open → resolved, and registry assets involved in events that were not in
  /// `previous`. The first snapshot (previous fetched at `.distantPast`) reports nothing, so opening
  /// the map does not flash every tile.
  nonisolated static func diff(previous: FloorSnapshot, next: FloorSnapshot, now: Date) -> Diff {
    var diff = Diff()
    guard previous.fetchedAt != .distantPast else { return diff }
    let wasOpen = Set(previous.issues.filter { !$0.isResolved }.map(\.id))
    for issue in next.issues where issue.isResolved && wasOpen.contains(issue.id) {
      diff.resolved[issue.id] = now
    }
    let seen = Set(previous.events.map(\.id))
    for event in next.events where !seen.contains(event.id) {
      for entity in next.involvesAsset[event.id] ?? [] {
        if let asset = next.assetForEntity[entity] { diff.touched[asset.id] = now }
      }
      if let label = event.label, let asset = FloorGeometry.match(name: label, in: next.assets) {
        diff.touched[asset.id] = now
      }
    }
    return diff
  }
}

extension FloorIssue {
  /// A copy marked resolved, for the optimistic update after `ack_alert`.
  func resolved(at date: Date?) -> FloorIssue {
    FloorIssue(id: id, eventId: eventId, at: at, kind: kind, text: text, entityId: entityId, entityName: entityName,
               wearerName: wearerName, deviceId: deviceId, isResolved: true, resolvedAt: date)
  }
}
