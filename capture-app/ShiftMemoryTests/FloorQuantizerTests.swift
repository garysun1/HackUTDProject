//
// FloorQuantizerTests.swift
// Shift Memory
//
// The barometric floor rule (issue #19): floor 0 where the shift started, one floor per
// `floorHeightM` of relative altitude, with hysteresis so a wearer on a landing or a slow weather
// drift does not make the floor flicker; CLFloor wins over the barometer when present.
//

import XCTest
@testable import ShiftMemory

final class FloorQuantizerTests: XCTestCase {
  /// 4 m floors, 0.25 floor (1 m) hysteresis: up from 0 at >= 3 m, down from 0 at <= -3 m.
  private let config = FloorQuantizer.Config(floorHeightM: 4, hysteresis: 0.25)

  func testStartsOnFloorZero() {
    let q = FloorQuantizer(config: config)
    XCTAssertEqual(q.floor, 0)
    XCTAssertNil(q.lastAltitudeM)
  }

  func testSmallAltitudeChangesKeepTheFloor() {
    var q = FloorQuantizer(config: config)
    for alt in [0.0, 0.4, -0.6, 1.9, 2.99, -2.99] {
      XCTAssertNil(q.update(relativeAltitudeM: alt), "\(alt) m")
      XCTAssertEqual(q.floor, 0)
    }
    XCTAssertEqual(q.lastAltitudeM, -2.99)
  }

  func testOneFloorUpNeedsHalfAFloorPlusHysteresis() {
    var q = FloorQuantizer(config: config)
    XCTAssertNil(q.update(relativeAltitudeM: 2.9))
    XCTAssertEqual(q.update(relativeAltitudeM: 3.0), 1)
    XCTAssertEqual(q.floor, 1)
  }

  func testOneFloorDownIsSymmetric() {
    var q = FloorQuantizer(config: config)
    XCTAssertNil(q.update(relativeAltitudeM: -2.9))
    XCTAssertEqual(q.update(relativeAltitudeM: -3.0), -1)
    XCTAssertEqual(q.update(relativeAltitudeM: -7.0), -2)
  }

  func testHysteresisStopsFlickerAroundABoundary() {
    var q = FloorQuantizer(config: config)
    XCTAssertEqual(q.update(relativeAltitudeM: 3.2), 1)
    // Back under the geometric boundary (2 m) but not past the hysteresis (1 m): stays on 1.
    for alt in [2.8, 2.1, 1.5, 1.01, 2.6, 1.2] {
      XCTAssertNil(q.update(relativeAltitudeM: alt), "\(alt) m")
      XCTAssertEqual(q.floor, 1)
    }
    // Clearly back on the ground floor.
    XCTAssertEqual(q.update(relativeAltitudeM: 0.9), 0)
    // And up again only once well past the boundary.
    XCTAssertNil(q.update(relativeAltitudeM: 2.5))
    XCTAssertEqual(q.update(relativeAltitudeM: 3.1), 1)
  }

  func testWalkingUpAStairwellReportsEachFloorOnce() {
    var q = FloorQuantizer(config: config)
    var changes: [Int] = []
    for i in 0...160 {  // 0 → 16 m in 10 cm steps
      if let f = q.update(relativeAltitudeM: Double(i) * 0.1) { changes.append(f) }
    }
    XCTAssertEqual(changes, [1, 2, 3, 4])
    XCTAssertEqual(q.floor, 4)
  }

  func testAJumpOfSeveralFloorsLandsOnTheNearest() {
    var q = FloorQuantizer(config: config)
    XCTAssertEqual(q.update(relativeAltitudeM: 11.9), 3)   // 11.9 / 4 = 2.98 → 3
    XCTAssertEqual(q.update(relativeAltitudeM: -0.2), 0)
  }

  func testJustPastTheEdgeNeverSnapsBackToTheOldFloor() {
    // With a large hysteresis the trigger altitude (3.8 m) still rounds to floor 1, never 0.
    var q = FloorQuantizer(config: .init(floorHeightM: 4, hysteresis: 0.45))
    XCTAssertEqual(q.update(relativeAltitudeM: 3.8), 1)
    XCTAssertEqual(q.update(relativeAltitudeM: 0.1), 0)
  }

  func testConfigurableFloorHeightForECSW() {
    var q = FloorQuantizer(config: .init(floorHeightM: 5.65, hysteresis: 0.25))
    XCTAssertNil(q.update(relativeAltitudeM: 4.0))       // < 0.75 × 5.65 = 4.24
    XCTAssertEqual(q.update(relativeAltitudeM: 4.3), 1)
    XCTAssertEqual(q.update(relativeAltitudeM: 11.3), 2)  // 2 floors = 11.3 m
  }

  func testNonFiniteSamplesAreIgnored() {
    var q = FloorQuantizer(config: config)
    XCTAssertNil(q.update(relativeAltitudeM: .nan))
    XCTAssertNil(q.update(relativeAltitudeM: .infinity))
    XCTAssertEqual(q.floor, 0)
    XCTAssertNil(q.lastAltitudeM)
  }

  func testResetReturnsToFloorZero() {
    var q = FloorQuantizer(config: config)
    _ = q.update(relativeAltitudeM: 8)
    q.reset()
    XCTAssertEqual(q.floor, 0)
    XCTAssertNil(q.lastAltitudeM)
  }

  func testConfigClampsNonsenseValues() {
    let c = FloorQuantizer.Config(floorHeightM: 0.1, hysteresis: 2)
    XCTAssertEqual(c.floorHeightM, FloorQuantizer.Config.floorHeightRange.lowerBound)
    XCTAssertEqual(c.hysteresis, FloorQuantizer.Config.hysteresisRange.upperBound)
    let d = FloorQuantizer.Config(floorHeightM: .nan, hysteresis: -1)
    XCTAssertEqual(d.floorHeightM, FloorQuantizer.Config.defaultFloorHeightM)
    XCTAssertEqual(d.hysteresis, 0)
  }

  func testStartingFloorIsKeptAcrossASettingsChange() {
    var q = FloorQuantizer(config: .init(floorHeightM: 5.65), floor: 2)
    XCTAssertEqual(q.floor, 2)
    XCTAssertNil(q.update(relativeAltitudeM: 11.3))
  }

  func testVenueFloorWinsOverTheBarometer() {
    XCTAssertEqual(FloorQuantizer.resolve(venueFloor: 3, barometricFloor: 1), 3)
    XCTAssertEqual(FloorQuantizer.resolve(venueFloor: nil, barometricFloor: 1), 1)
    XCTAssertNil(FloorQuantizer.resolve(venueFloor: nil, barometricFloor: nil))
  }

  func testFloorReachesTheContractJSON() throws {
    var fix = LocationFix(lat: 32.9858, lon: -96.7502, accuracyM: 5, t: Date(timeIntervalSince1970: 1_794_102_000))
    fix.floor = FloorQuantizer.resolve(venueFloor: nil, barometricFloor: -1)
    let json = TrackJSONText.object(fix.contractObject(offsetSeconds: 0), order: LocationFix.contractKeyOrder)
    XCTAssertTrue(json.contains(#""accuracy_m":5,"floor":-1,"t":"#), json)
  }
}
