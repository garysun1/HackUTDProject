//
// ShiftMotion.swift
// Shift Memory
//
// The two Core Motion signals `FloorFusion` cross-checks the barometer against during a shift
// (issue #19): CMPedometer's floor count (floorsAscended / floorsDescended, cumulative since the
// shift started; stairs only, elevators do not count) and CMMotionActivity (stationary / walking /
// …, with confidence). Started at Start shift, stopped at End shift. Covered by the same
// `NSMotionUsageDescription` as the altimeter.
//
// Threading: Core Motion calls back on the queue we give it; each callback is reduced to plain
// values before a main-actor hop.
//

import CoreMotion
import Foundation
import Observation

@MainActor
@Observable
final class ShiftMotion {
  /// Cumulative floors since the shift started; nil until the pedometer reports or when unavailable.
  private(set) var floorsAscended: Int?
  private(set) var floorsDescended: Int?
  /// `stationary` | `walking` | `running` | `automotive` | `cycling` | `unknown`; nil before the first update.
  private(set) var activity: String?
  /// `low` | `medium` | `high`
  private(set) var activityConfidence: String?
  private(set) var isRunning = false

  var isPedometerAvailable: Bool { CMPedometer.isFloorCountingAvailable() }
  var isActivityAvailable: Bool { CMMotionActivityManager.isActivityAvailable() }

  /// Floors counted either way, the fusion's rule (a) input.
  var pedometerFloors: Int? {
    guard floorsAscended != nil || floorsDescended != nil else { return nil }
    return (floorsAscended ?? 0) + (floorsDescended ?? 0)
  }

  /// Stationary with at least medium confidence; false for any movement; nil when unknown.
  var isStationary: Bool? {
    guard let activity else { return nil }
    if activity == "unknown" { return nil }
    if activity == "stationary" { return activityConfidence != "low" }
    return false
  }

  @ObservationIgnored private let pedometer = CMPedometer()
  @ObservationIgnored private let activityManager = CMMotionActivityManager()
  @ObservationIgnored private let log: (String) -> Void
  @ObservationIgnored private let queue: OperationQueue = {
    let q = OperationQueue()
    q.name = "shiftmemory.motion"
    q.maxConcurrentOperationCount = 1
    q.qualityOfService = .utility
    return q
  }()
  @ObservationIgnored private var generation = 0

  init(log: @escaping (String) -> Void) {
    self.log = log
  }

  /// Counts floors from `start` (the shift start) and follows the activity. Restarts if running.
  func start(from start: Date) {
    if isRunning { stopUpdates() }
    generation += 1
    let gen = generation
    isRunning = true
    floorsAscended = nil
    floorsDescended = nil
    activity = nil
    activityConfidence = nil
    if CMPedometer.isFloorCountingAvailable() {
      pedometer.startUpdates(from: start) { [weak self] data, error in
        let up = data?.floorsAscended?.intValue
        let down = data?.floorsDescended?.intValue
        let errorText = error?.localizedDescription
        Task { @MainActor [weak self] in
          guard let self, gen == self.generation else { return }
          if let errorText { self.log("pedometer error: \(errorText)"); return }
          if up != self.floorsAscended || down != self.floorsDescended {
            self.log("pedometer floors up \(up ?? 0) down \(down ?? 0)")
          }
          self.floorsAscended = up
          self.floorsDescended = down
        }
      }
    } else {
      log("pedometer floor counting not available on this device")
    }
    if CMMotionActivityManager.isActivityAvailable() {
      activityManager.startActivityUpdates(to: queue) { [weak self] activity in
        guard let activity else { return }
        let name = Self.name(of: activity)
        let confidence = Self.name(of: activity.confidence)
        Task { @MainActor [weak self] in
          guard let self, gen == self.generation else { return }
          if name != self.activity { self.log("activity \(name) (\(confidence))") }
          self.activity = name
          self.activityConfidence = confidence
        }
      }
    } else {
      log("motion activity not available on this device")
    }
    log("pedometer and activity updates started from \(start.formatted(.iso8601))")
  }

  func stop() {
    guard isRunning else { return }
    stopUpdates()
    log("pedometer and activity updates stopped (floors up \(floorsAscended ?? 0) down \(floorsDescended ?? 0))")
  }

  private func stopUpdates() {
    pedometer.stopUpdates()
    activityManager.stopActivityUpdates()
    generation += 1
    isRunning = false
  }

  nonisolated static func name(of a: CMMotionActivity) -> String {
    if a.stationary { return "stationary" }
    if a.walking { return "walking" }
    if a.running { return "running" }
    if a.automotive { return "automotive" }
    if a.cycling { return "cycling" }
    return "unknown"
  }

  nonisolated static func name(of c: CMMotionActivityConfidence) -> String {
    switch c {
    case .low: return "low"
    case .medium: return "medium"
    case .high: return "high"
    @unknown default: return "unknown"
    }
  }
}
