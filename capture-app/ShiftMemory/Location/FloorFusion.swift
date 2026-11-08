//
// FloorFusion.swift
// Shift Memory
//
// The barometer alone flips floors on weather drift and on a wearer who leans over a railing.
// `FloorFusion` sits in front of `FloorQuantizer` and only lets a floor change through when the
// other sensors agree (issue #19, calibration build):
//   (a) the pedometer's floor count (CMPedometer floorsAscended + floorsDescended) changed within
//       the last 60 s — stairs register there, elevators do not, so next to an elevator the
//       barometer may move the floor alone unless `pedometerRequiredNearElevator` is set;
//   (b) the last GPS fix is within 20 m of a staircase or elevator of the site (`FloorSites`),
//       or there is no fix at all (deep indoors);
//   (c) while the wearer is stationary and away from stairs, a drift of less than half a floor
//       moves the altitude baseline instead of the floor.
// Pure value type; every rule is unit-tested (ShiftMemoryTests/FloorFusionTests). Every call
// returns a `Decision` so the tracker can write the reason to debug.log.
//

import Foundation

struct FloorFusion: Sendable {
  struct Config: Sendable, Equatable {
    var quantizer = FloorQuantizer.Config()
    /// (a) How recently the pedometer's floor count must have changed.
    var pedometerWindow: TimeInterval = 60
    /// (b) How close the last fix must be to a stair or elevator.
    var siteRadiusM = 40.0                   // indoor GPS at ECSW read the stairs at 24–35 m
    var sites: [FloorSite] = FloorSites.ecsw
    /// (a) Also demand a pedometer change when the wearer stands at an elevator (the pedometer
    /// never counts elevator floors, so true disables elevator rides).
    var pedometerRequiredNearElevator = false
    /// (c) Drift smaller than this is not worth reporting as a re-zero (still applied).
    var reportedRezeroM = 0.1
  }

  /// One tick of sensor state. Unknown signals are nil and do not block a change.
  struct Sample: Sendable {
    var t: Date
    /// Metres since the shift started, straight from the altimeter.
    var relativeAltitudeM: Double
    /// Cumulative pedometer floors (ascended + descended) since the shift started.
    var pedometerFloors: Int?
    /// CMMotionActivity `stationary` (with at least medium confidence); nil when unknown.
    var isStationary: Bool?
    var fix: LocationFix?
  }

  enum Decision: Sendable, Equatable {
    case none
    case accepted(from: Int, to: Int, reason: String)
    case rejected(from: Int, to: Int, reason: String)
    /// Rule (c): the baseline moved by this much (metres).
    case rezeroed(byM: Double, offsetM: Double)
  }

  private(set) var config: Config
  private(set) var quantizer: FloorQuantizer
  /// Subtracted from the raw relative altitude; grows as rule (c) absorbs drift.
  private(set) var baselineOffsetM = 0.0
  private var lastPedometerFloors: Int?
  private var lastPedometerChangeAt: Date?

  init(config: Config = .init()) {
    self.config = config
    self.quantizer = FloorQuantizer(config: config.quantizer)
  }

  var floor: Int { quantizer.floor }
  /// The altitude the quantiser last saw (drift removed).
  var effectiveAltitudeM: Double? { quantizer.lastAltitudeM }

  /// New step / hysteresis mid-shift: keeps the floor, the baseline and the pedometer history.
  mutating func setConfig(_ new: Config) {
    config = new
    quantizer = FloorQuantizer(config: new.quantizer, floor: quantizer.floor)
  }

  mutating func reset() {
    quantizer.reset()
    baselineOffsetM = 0
    lastPedometerFloors = nil
    lastPedometerChangeAt = nil
  }

  mutating func update(_ s: Sample) -> Decision {
    guard s.relativeAltitudeM.isFinite else { return .none }
    if let floors = s.pedometerFloors {
      if let last = lastPedometerFloors, floors != last { lastPedometerChangeAt = s.t }
      lastPedometerFloors = floors
    }
    let h = config.quantizer.floorHeightM
    let effective = s.relativeAltitudeM - baselineOffsetM
    let nearest = s.fix.flatMap { FloorSites.nearest(to: $0, in: config.sites) }
    let nearSite = nearest.map { $0.distanceM <= config.siteRadiusM } ?? false
    let awayFromSites = s.fix != nil && !nearSite

    // (c) Standing still away from any stairs: drift under half a floor is drift, not a floor.
    if s.isStationary == true, awayFromSites {
      let deviation = effective - Double(quantizer.floor) * h
      if abs(deviation) < 0.5 * h {
        baselineOffsetM += deviation
        _ = quantizer.update(relativeAltitudeM: effective - deviation)
        return abs(deviation) >= config.reportedRezeroM ? .rezeroed(byM: deviation, offsetM: baselineOffsetM) : .none
      }
    }

    var proposed = quantizer
    guard let next = proposed.update(relativeAltitudeM: effective) else {
      quantizer = proposed
      return .none
    }
    let from = quantizer.floor

    // (b) Only at a stair or elevator, unless GPS has nothing to say.
    if let nearest, !nearSite {
      return .rejected(from: from, to: next, reason: "no stair or elevator within \(Int(config.siteRadiusM)) m (nearest \(nearest.site.name) at \(Int(nearest.distanceM.rounded())) m)")
    }
    // (a) The pedometer must have seen stairs recently, except at an elevator.
    let atElevator = nearSite && nearest?.site.kind == .elevator
    if s.pedometerFloors != nil, !(atElevator && !config.pedometerRequiredNearElevator) {
      let recent = lastPedometerChangeAt.map { s.t.timeIntervalSince($0) <= config.pedometerWindow } ?? false
      if !recent {
        return .rejected(from: from, to: next, reason: "pedometer floors unchanged in the last \(Int(config.pedometerWindow)) s")
      }
    }

    quantizer = proposed
    var why: [String] = []
    why.append(nearest.map { "\($0.site.name) at \(Int($0.distanceM.rounded())) m" } ?? "no GPS fix")
    if s.pedometerFloors == nil { why.append("pedometer unavailable") }
    else if atElevator && !config.pedometerRequiredNearElevator { why.append("elevator: pedometer not required") }
    else { why.append("pedometer floors changed \(Int(s.t.timeIntervalSince(lastPedometerChangeAt ?? s.t))) s ago") }
    return .accepted(from: from, to: next, reason: why.joined(separator: ", "))
  }
}
