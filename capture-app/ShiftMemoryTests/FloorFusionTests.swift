//
// FloorFusionTests.swift
// Shift Memory
//
// The fusion rules in front of the floor quantiser (issue #19): (a) pedometer floors must have
// changed within 60 s, (b) the last fix must be within 20 m of a stair/elevator or absent,
// (c) small drift while stationary away from stairs re-zeroes the baseline.
//

import XCTest
@testable import ShiftMemory

final class FloorFusionTests: XCTestCase {
  private let t0 = Date(timeIntervalSince1970: 1_794_200_000)
  /// 4 m floors, 1 m hysteresis: 3 m up is a floor.
  private var config: FloorFusion.Config {
    var c = FloorFusion.Config()
    c.quantizer = FloorQuantizer.Config(floorHeightM: 4, hysteresis: 0.25)
    return c
  }
  private let eastStairs = FloorSites.ecsw[0]
  private let eastElevator = FloorSites.ecsw[3]

  private func fix(at site: FloorSite, offsetNorthM: Double = 0, acc: Double = 8) -> LocationFix {
    LocationFix(lat: site.lat + offsetNorthM / 111_195, lon: site.lon, accuracyM: acc, t: t0)
  }
  /// ~60 m north of the east stairs: inside the building, far from every stair and elevator.
  private var farFix: LocationFix { fix(at: eastStairs, offsetNorthM: 60) }

  private func sample(_ dt: TimeInterval, alt: Double, floors: Int? = nil, stationary: Bool? = nil, fix: LocationFix? = nil) -> FloorFusion.Sample {
    FloorFusion.Sample(t: t0.addingTimeInterval(dt), relativeAltitudeM: alt, pedometerFloors: floors, isStationary: stationary, fix: fix)
  }

  // MARK: (a) pedometer

  func testBarometerStepWithRecentPedometerFloorIsAccepted() {
    var f = FloorFusion(config: config)
    XCTAssertEqual(f.update(sample(0, alt: 0, floors: 0, fix: fix(at: eastStairs))), .none)
    XCTAssertEqual(f.update(sample(20, alt: 1.5, floors: 1, fix: fix(at: eastStairs))), .none)
    guard case .accepted(let from, let to, _) = f.update(sample(30, alt: 3.2, floors: 1, fix: fix(at: eastStairs))) else {
      return XCTFail("expected accepted")
    }
    XCTAssertEqual([from, to], [0, 1])
    XCTAssertEqual(f.floor, 1)
  }

  func testBarometerStepWithoutPedometerChangeIsRejected() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, fix: fix(at: eastStairs)))
    let d = f.update(sample(30, alt: 3.2, floors: 0, fix: fix(at: eastStairs)))
    guard case .rejected(0, 1, let reason) = d else { return XCTFail("expected rejected, got \(d)") }
    XCTAssertTrue(reason.contains("pedometer"), reason)
    XCTAssertEqual(f.floor, 0)
  }

  func testPedometerChangeOlderThanTheWindowDoesNotCount() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, fix: fix(at: eastStairs)))
    _ = f.update(sample(5, alt: 0.5, floors: 1, fix: fix(at: eastStairs)))      // change at t=5
    guard case .rejected = f.update(sample(66, alt: 3.2, floors: 1, fix: fix(at: eastStairs))) else { return XCTFail() }
    // A fresh change makes it go through.
    guard case .accepted = f.update(sample(70, alt: 3.2, floors: 2, fix: fix(at: eastStairs))) else { return XCTFail() }
  }

  func testElevatorRideNeedsNoPedometer() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, fix: fix(at: eastElevator)))
    guard case .accepted(_, _, let reason) = f.update(sample(40, alt: -3.5, floors: 0, fix: fix(at: eastElevator))) else { return XCTFail() }
    XCTAssertTrue(reason.contains("elevator"), reason)
    XCTAssertEqual(f.floor, -1)
  }

  func testElevatorExceptionCanBeTurnedOff() {
    var c = config
    c.pedometerRequiredNearElevator = true
    var f = FloorFusion(config: c)
    _ = f.update(sample(0, alt: 0, floors: 0, fix: fix(at: eastElevator)))
    guard case .rejected = f.update(sample(40, alt: -3.5, floors: 0, fix: fix(at: eastElevator))) else { return XCTFail() }
  }

  func testNoPedometerAtAllDoesNotBlockTheChange() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, fix: fix(at: eastStairs)))
    guard case .accepted(_, _, let reason) = f.update(sample(30, alt: 3.2, fix: fix(at: eastStairs))) else { return XCTFail() }
    XCTAssertTrue(reason.contains("pedometer unavailable"), reason)
  }

  // MARK: (b) GPS near a stair or elevator

  func testChangeAwayFromAnyStairOrElevatorIsRejected() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, fix: farFix))
    let d = f.update(sample(30, alt: 3.2, floors: 1, fix: farFix))
    guard case .rejected(0, 1, let reason) = d else { return XCTFail("\(d)") }
    XCTAssertTrue(reason.contains("no stair or elevator within 20 m"), reason)
    XCTAssertEqual(f.floor, 0)
  }

  func testTwentyMetresIsTheEdge() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, fix: fix(at: eastStairs, offsetNorthM: 19)))
    guard case .accepted = f.update(sample(30, alt: 3.2, floors: 1, fix: fix(at: eastStairs, offsetNorthM: 19))) else { return XCTFail() }
    var g = FloorFusion(config: config)
    _ = g.update(sample(0, alt: 0, floors: 0, fix: fix(at: eastStairs, offsetNorthM: 21)))
    guard case .rejected = g.update(sample(30, alt: 3.2, floors: 1, fix: fix(at: eastStairs, offsetNorthM: 21))) else { return XCTFail() }
  }

  func testNoFixAtAllLetsTheChangeThrough() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0))
    guard case .accepted(_, _, let reason) = f.update(sample(30, alt: 3.2, floors: 1)) else { return XCTFail() }
    XCTAssertTrue(reason.contains("no GPS fix"), reason)
  }

  func testRejectedChangeKeepsTheFloorUntilTheSensorsAgree() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, fix: farFix))
    guard case .rejected = f.update(sample(30, alt: 3.2, floors: 1, fix: farFix)) else { return XCTFail() }
    // Walks over to the stairs with the same altitude: now accepted.
    guard case .accepted = f.update(sample(45, alt: 3.2, floors: 1, fix: fix(at: eastStairs))) else { return XCTFail() }
  }

  // MARK: (c) drift re-zero

  func testDriftWhileStationaryAwayFromStairsMovesTheBaselineNotTheFloor() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, stationary: true, fix: farFix))
    // 1.4 m of "climb" while standing still far from any stairs.
    let d = f.update(sample(300, alt: 1.4, floors: 0, stationary: true, fix: farFix))
    guard case .rezeroed(let by, let offset) = d else { return XCTFail("\(d)") }
    XCTAssertEqual(by, 1.4, accuracy: 1e-9)
    XCTAssertEqual(offset, 1.4, accuracy: 1e-9)
    XCTAssertEqual(f.floor, 0)
    // Then real stairs: the baseline is already 1.4 m up, so 3 m more is needed from there.
    XCTAssertEqual(f.update(sample(400, alt: 4.0, floors: 1, stationary: false, fix: fix(at: eastStairs))), .none)
    guard case .accepted = f.update(sample(410, alt: 4.5, floors: 1, stationary: false, fix: fix(at: eastStairs))) else { return XCTFail() }
  }

  func testTinyDriftIsAbsorbedQuietly() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, stationary: true, fix: farFix))
    XCTAssertEqual(f.update(sample(10, alt: 0.05, stationary: true, fix: farFix)), .none)
    XCTAssertEqual(f.baselineOffsetM, 0.05, accuracy: 1e-9)
  }

  func testHalfAFloorOrMoreWhileStationaryIsNotDrift() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, stationary: true, fix: farFix))
    // 2.2 m (> 0.5 floor) is a candidate change, which (b) then rejects away from stairs.
    guard case .rejected = f.update(sample(60, alt: 3.2, floors: 0, stationary: true, fix: farFix)) else { return XCTFail() }
    XCTAssertEqual(f.baselineOffsetM, 0)
  }

  func testNoRezeroWhileWalkingOrNearStairs() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, stationary: false, fix: farFix))
    XCTAssertEqual(f.update(sample(10, alt: 1.4, stationary: false, fix: farFix)), .none)
    XCTAssertEqual(f.baselineOffsetM, 0)
    _ = f.update(sample(20, alt: 1.4, stationary: true, fix: fix(at: eastStairs)))
    XCTAssertEqual(f.baselineOffsetM, 0)
    // Unknown activity: no re-zero either.
    _ = f.update(sample(30, alt: 1.4, stationary: nil, fix: farFix))
    XCTAssertEqual(f.baselineOffsetM, 0)
  }

  // MARK: Housekeeping

  func testResetClearsBaselineAndPedometerHistory() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, stationary: true, fix: farFix))
    _ = f.update(sample(10, alt: 1, floors: 1, stationary: true, fix: farFix))
    f.reset()
    XCTAssertEqual(f.floor, 0)
    XCTAssertEqual(f.baselineOffsetM, 0)
    // The pedometer change before reset must not count: rejected for lack of a recent one.
    _ = f.update(sample(20, alt: 0, floors: 1, fix: fix(at: eastStairs)))
    guard case .rejected = f.update(sample(30, alt: 3.2, floors: 1, fix: fix(at: eastStairs))) else { return XCTFail() }
  }

  func testSetConfigKeepsFloorAndBaseline() {
    var f = FloorFusion(config: config)
    _ = f.update(sample(0, alt: 0, floors: 0, fix: fix(at: eastStairs)))
    _ = f.update(sample(30, alt: 3.2, floors: 1, fix: fix(at: eastStairs)))
    XCTAssertEqual(f.floor, 1)
    var c = config
    c.quantizer = FloorQuantizer.Config(floorHeightM: 5.65)
    f.setConfig(c)
    XCTAssertEqual(f.floor, 1)
    XCTAssertEqual(f.config.quantizer.floorHeightM, 5.65)
  }

  func testSiteTableHasECSWStairsAndElevators() {
    let sites = try! XCTUnwrap(FloorSites.bySite["ecsw"])
    XCTAssertEqual(sites.filter { $0.kind == .stairs }.count, 3)
    XCTAssertEqual(sites.filter { $0.kind == .elevator }.count, 3)
    let n = try! XCTUnwrap(FloorSites.nearest(to: fix(at: eastElevator), in: sites))
    XCTAssertEqual(n.site, eastElevator)
    XCTAssertEqual(n.distanceM, 0, accuracy: 0.01)
  }
}
