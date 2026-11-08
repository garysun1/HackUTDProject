//
// FloorQuantizer.swift
// Shift Memory
//
// Turns the barometer's relative altitude (metres above where the shift started) into a floor
// number: 0 = the floor the shift started on, +1 per floor up, -1 per floor down (contract v3.1
// `floor`, an I32 on the module side). Pure value type so the rules are unit-tested
// (ShiftMemoryTests/FloorQuantizerTests).
//
// Rule: floor f spans the altitude band [(f - 0.5) h, (f + 0.5) h) where h is the floor height.
// To leave the current floor the altitude must cross the band edge by an extra `hysteresis` of a
// floor, so a wearer standing on a landing, or a weather drift of a few decimetres, does not flip
// the floor back and forth. A stairwell climb of several floors lands directly on the nearest
// floor once the first boundary is crossed.
//

import Foundation

struct FloorQuantizer: Sendable, Equatable {
  struct Config: Sendable, Equatable {
    /// Metres of altitude per floor. 4.0 m suits most commercial buildings; ECSW at UT Dallas is
    /// 22.6 m over 4 levels = 5.65 m floor to floor (unconfirmed by a hardware run; see HANDOFF.md).
    var floorHeightM = 4.0
    /// Fraction of a floor the altitude must overshoot a band edge by before the floor changes.
    /// 0.25 of a 4 m floor is 1 m: well above the barometer's noise (~0.1–0.3 m), well under a half floor.
    var hysteresis = 0.25

    /// ECSW measured 5.7 / 5.2 / 5.5 m per floor on the 2026-11-08 calibration walk (capture-app/calibration/).
    static let defaultFloorHeightM = 5.5
    /// Floor heights outside this range make no sense for a building and are clamped.
    static let floorHeightRange: ClosedRange<Double> = 2.5...8.0
    /// Hysteresis is clamped so that a change always needs less than one full floor of overshoot.
    static let hysteresisRange: ClosedRange<Double> = 0...0.45

    init(floorHeightM: Double = Config.defaultFloorHeightM, hysteresis: Double = 0.25) {
      self.floorHeightM = floorHeightM.isFinite ? min(max(floorHeightM, Self.floorHeightRange.lowerBound), Self.floorHeightRange.upperBound) : Self.defaultFloorHeightM
      self.hysteresis = hysteresis.isFinite ? min(max(hysteresis, Self.hysteresisRange.lowerBound), Self.hysteresisRange.upperBound) : 0.25
    }
  }

  let config: Config
  /// The current floor relative to where the shift started.
  private(set) var floor: Int = 0
  /// The last relative altitude fed in, metres.
  private(set) var lastAltitudeM: Double?

  init(config: Config = .init()) {
    self.config = config
  }

  /// Starts on `floor` (a settings change mid-shift keeps the floor the wearer is on).
  init(config: Config, floor: Int) {
    self.config = config
    self.floor = floor
  }

  /// Feeds one relative-altitude sample. Returns the new floor when it changed, else nil.
  /// Non-finite samples are ignored.
  @discardableResult
  mutating func update(relativeAltitudeM altitude: Double) -> Int? {
    guard altitude.isFinite else { return nil }
    lastAltitudeM = altitude
    let h = config.floorHeightM
    let up = (Double(floor) + 0.5 + config.hysteresis) * h
    let down = (Double(floor) - 0.5 - config.hysteresis) * h
    guard altitude >= up || altitude <= down else { return nil }
    // Past the edge: snap to the band the altitude is actually in, never back to the old floor.
    var next = Int((altitude / h).rounded(.toNearestOrAwayFromZero))
    if altitude >= up { next = max(next, floor + 1) } else { next = min(next, floor - 1) }
    guard next != floor else { return nil }
    floor = next
    return next
  }

  /// A new shift: back to floor 0 at the current altitude (the altimeter is re-zeroed alongside).
  mutating func reset() {
    floor = 0
    lastAltitudeM = nil
  }

  /// The floor an event or track point carries: the venue's own level when Core Location knows it
  /// (`CLFloor.level`, an indoor survey), else the barometric floor relative to the shift start.
  static func resolve(venueFloor: Int?, barometricFloor: Int?) -> Int? {
    venueFloor ?? barometricFloor
  }
}
