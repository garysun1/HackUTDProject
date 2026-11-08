//
// TrackSampler.swift
// Shift Memory
//
// Decides which Core Location fixes become points of the shift track (`ingest_track`, contract
// v3.1, issue #20). Core Location delivers ~1 fix/s with kCLDistanceFilterNone; the track keeps a
// point when the wearer moved >= 5 m or 30 s passed, and only fixes accurate to 50 m. Pure value
// type with no Core Location state so every rule is unit-tested (ShiftMemoryTests/TrackSamplerTests).
//

import Foundation

struct TrackSampler: Sendable {
  struct Config: Sendable, Equatable {
    /// Keep a fix when it is at least this far from the last kept one.
    var minDistanceM = 5.0
    /// Keep a fix when at least this long after the last kept one, even if the wearer stood still.
    var minInterval: TimeInterval = 30
    /// Never keep a fix with a worse (larger) horizontal accuracy than this.
    var maxAccuracyM = 50.0
    /// How far behind the last kept fix an out-of-order fix may be and still be considered.
    /// 0 (the default) means timestamps must be strictly increasing, which the module's
    /// idempotency key (device_id, t) relies on. Equal timestamps are rejected regardless.
    var maxBackwardsSkew: TimeInterval = 0
  }

  /// Fixes closer than this to the last kept one are "the same instant": `t` is serialized with
  /// millisecond precision (DateFormatter "SSS" truncates), so two points under ~1 ms apart could
  /// collide on the module's (device_id, t) key. 10 ms leaves room for Date's floating-point error
  /// at ~1e9 s; real fixes are >= ~1 s apart, so nothing genuine is lost.
  static let minTimeStep: TimeInterval = 0.01
  /// A much more accurate fix (less than half the radius) supersedes a poor one after this long.
  static let accuracyUpgradeInterval: TimeInterval = 2

  let config: Config
  private(set) var lastKept: LocationFix?

  init(config: Config = .init()) {
    self.config = config
  }

  /// Whether `fix` becomes a track point. When it does, it is the new `lastKept`.
  mutating func accept(_ fix: LocationFix) -> Bool {
    guard fix.accuracyM >= 0, fix.accuracyM <= config.maxAccuracyM else { return false }
    guard let last = lastKept else {
      lastKept = fix
      return true
    }
    let dt = fix.t.timeIntervalSince(last.t)
    // Cached or out-of-order deliveries: never step back in time (beyond the configured skew),
    // and never repeat a timestamp at the contract's millisecond resolution.
    guard abs(dt) >= Self.minTimeStep else { return false }
    guard dt > 0 || -dt <= config.maxBackwardsSkew else { return false }

    let moved = fix.distance(to: last) >= config.minDistanceM
    let waited = dt >= config.minInterval
    let sharper = fix.accuracyM < last.accuracyM / 2 && dt >= Self.accuracyUpgradeInterval
    guard moved || waited || sharper else { return false }
    lastKept = fix
    return true
  }

  /// Forget the last kept fix (a new shift starts a new track).
  mutating func reset() {
    lastKept = nil
  }
}
