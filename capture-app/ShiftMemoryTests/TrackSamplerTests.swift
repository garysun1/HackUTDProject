//
// TrackSamplerTests.swift
// Shift Memory
//
// The shift track's sampling rules (issue #20: >= 5 m or 30 s, accuracy <= 50 m, monotonic time,
// accuracy upgrade) and the LocationFix value the track and events share (validity of Core Location
// fixes, contract rounding and optional keys, the 100 m / 120 s event rule).
//

import CoreLocation
import XCTest
@testable import ShiftMemory

final class TrackSamplerTests: XCTestCase {
  private let t0 = Date(timeIntervalSince1970: 1_794_000_000)
  private let baseLat = 32.9857
  private let baseLon = -96.7502

  /// A fix `north` metres north of the base point, `seconds` after t0.
  private func fix(north: Double = 0, seconds: TimeInterval = 0, accuracy: Double = 5) -> LocationFix {
    LocationFix(lat: baseLat + north / 111_195, lon: baseLon, accuracyM: accuracy, t: t0.addingTimeInterval(seconds))
  }

  // MARK: - TrackSampler

  func testFirstAcceptableFixIsKept() {
    var s = TrackSampler()
    XCTAssertNil(s.lastKept)
    XCTAssertTrue(s.accept(fix()))
    XCTAssertEqual(s.lastKept, fix())
  }

  func testFixWorseThanMaxAccuracyIsRejectedEvenFirst() {
    var s = TrackSampler()
    XCTAssertFalse(s.accept(fix(accuracy: 50.1)))
    XCTAssertNil(s.lastKept)
    XCTAssertTrue(s.accept(fix(seconds: 1, accuracy: 50)))  // exactly 50 m is allowed
  }

  func testNegativeAccuracyIsRejected() {
    var s = TrackSampler()
    XCTAssertFalse(s.accept(fix(accuracy: -1)))
  }

  func testSmallMoveSoonAfterIsDropped() {
    var s = TrackSampler()
    XCTAssertTrue(s.accept(fix()))
    let near = fix(north: 4.9, seconds: 10)
    XCTAssertLessThan(near.distance(to: fix()), 5)
    XCTAssertFalse(s.accept(near))
    XCTAssertEqual(s.lastKept, fix())
  }

  func testMoveOfFiveMetresIsKept() {
    var s = TrackSampler()
    XCTAssertTrue(s.accept(fix()))
    let moved = fix(north: 5.05, seconds: 1)
    XCTAssertGreaterThanOrEqual(moved.distance(to: fix()), 5)
    XCTAssertTrue(s.accept(moved))
    XCTAssertEqual(s.lastKept, moved)
  }

  func testDistanceIsMeasuredFromLastKeptNotLastSeen() {
    var s = TrackSampler()
    XCTAssertTrue(s.accept(fix()))
    XCTAssertFalse(s.accept(fix(north: 3, seconds: 1)))
    XCTAssertTrue(s.accept(fix(north: 6, seconds: 2)))  // 3 m from the dropped one, 6 m from the kept one
  }

  func testStandingStillKeepsOnePointEveryInterval() {
    var s = TrackSampler()
    XCTAssertTrue(s.accept(fix()))
    XCTAssertFalse(s.accept(fix(seconds: 29.9)))
    XCTAssertTrue(s.accept(fix(seconds: 30)))  // exactly minInterval
    XCTAssertFalse(s.accept(fix(seconds: 59)))
    XCTAssertTrue(s.accept(fix(seconds: 60)))
  }

  func testOutOfOrderAndRepeatedTimestampsAreRejected() {
    var s = TrackSampler()
    XCTAssertTrue(s.accept(fix(seconds: 100)))
    XCTAssertFalse(s.accept(fix(north: 50, seconds: 100)))  // same t, far away
    XCTAssertFalse(s.accept(fix(north: 50, seconds: 40)))   // older (cached) fix
    XCTAssertFalse(s.accept(fix(north: 50, seconds: 100.0005)))  // same millisecond on the wire
    XCTAssertFalse(s.accept(fix(north: 50, seconds: 100.005)))   // under minTimeStep (10 ms)
    XCTAssertFalse(s.accept(fix(north: 50, seconds: 99.995)))
    XCTAssertTrue(s.accept(fix(north: 50, seconds: 101)))
  }

  func testBackwardsSkewToleranceIsConfigurable() {
    var s = TrackSampler(config: .init(maxBackwardsSkew: 5))
    XCTAssertTrue(s.accept(fix(seconds: 100)))
    XCTAssertTrue(s.accept(fix(north: 20, seconds: 97)))   // 3 s behind, moved
    XCTAssertFalse(s.accept(fix(north: 40, seconds: 90)))  // 7 s behind the last kept (97)
  }

  func testMuchBetterAccuracySupersedesAPoorFix() {
    var s = TrackSampler()
    XCTAssertTrue(s.accept(fix(accuracy: 40)))
    XCTAssertFalse(s.accept(fix(seconds: 1.9, accuracy: 10)))  // better, but under 2 s
    XCTAssertTrue(s.accept(fix(seconds: 2, accuracy: 19.9)))   // < half, 2 s later
    XCTAssertEqual(s.lastKept?.accuracyM, 19.9)
  }

  func testOnlySlightlyBetterAccuracyIsNotAnUpgrade() {
    var s = TrackSampler()
    XCTAssertTrue(s.accept(fix(accuracy: 40)))
    XCTAssertFalse(s.accept(fix(seconds: 5, accuracy: 20)))  // exactly half is not "< half"
  }

  func testKeptPointsHaveDistinctMillisecondTimestamps() {
    var s = TrackSampler()
    var kept: [String] = []
    // A fast-moving burst 1 ms apart: only points >= minTimeStep apart may be kept.
    for i in 0..<200 {
      let f = fix(north: Double(i) * 10, seconds: Double(i) * 0.001)
      if s.accept(f) { kept.append(EventEnvelope.iso8601(f.t, offsetSeconds: 0)) }
    }
    // ~one per 10 ms (floating-point steps of 0.001 s may skip one boundary).
    XCTAssertTrue((18...20).contains(kept.count), "kept \(kept.count)")
    XCTAssertEqual(Set(kept).count, kept.count)
  }

  func testInaccurateFixDoesNotMoveLastKept() {
    var s = TrackSampler()
    XCTAssertTrue(s.accept(fix()))
    XCTAssertFalse(s.accept(fix(north: 100, seconds: 60, accuracy: 80)))
    XCTAssertEqual(s.lastKept, fix())
  }

  func testResetStartsANewTrack() {
    var s = TrackSampler()
    XCTAssertTrue(s.accept(fix(seconds: 100)))
    s.reset()
    XCTAssertNil(s.lastKept)
    XCTAssertTrue(s.accept(fix(seconds: 50)))  // earlier than the old track: fine after reset
  }

  func testCustomConfigIsHonoured() {
    var s = TrackSampler(config: .init(minDistanceM: 20, minInterval: 10, maxAccuracyM: 15))
    XCTAssertFalse(s.accept(fix(accuracy: 16)))
    XCTAssertTrue(s.accept(fix(seconds: 1, accuracy: 10)))
    XCTAssertFalse(s.accept(fix(north: 10, seconds: 5, accuracy: 10)))
    XCTAssertTrue(s.accept(fix(north: 21, seconds: 6, accuracy: 10)))
    XCTAssertTrue(s.accept(fix(north: 21, seconds: 16, accuracy: 10)))
  }

  // MARK: - LocationFix.init?(CLLocation)

  private func location(lat: Double = 32.9857, lon: Double = -96.7502, alt: Double = 180,
                        hAcc: Double = 8, vAcc: Double = 4, course: Double = 90, courseAcc: Double = 10,
                        speed: Double = 1.4, speedAcc: Double = 0.5) -> CLLocation {
    CLLocation(coordinate: CLLocationCoordinate2D(latitude: lat, longitude: lon), altitude: alt,
               horizontalAccuracy: hAcc, verticalAccuracy: vAcc, course: course, courseAccuracy: courseAcc,
               speed: speed, speedAccuracy: speedAcc, timestamp: t0)
  }

  func testValidLocationCopiesEveryField() throws {
    let f = try XCTUnwrap(LocationFix(location()))
    XCTAssertEqual(f.lat, 32.9857)
    XCTAssertEqual(f.lon, -96.7502)
    XCTAssertEqual(f.accuracyM, 8)
    XCTAssertEqual(f.altM, 180)
    XCTAssertEqual(f.altAccuracyM, 4)
    XCTAssertNil(f.floor)
    XCTAssertEqual(f.speedMps, 1.4)
    XCTAssertEqual(f.courseDeg, 90)
    XCTAssertEqual(f.t, t0)
  }

  func testNegativeHorizontalAccuracyIsNotAFix() {
    XCTAssertNil(LocationFix(location(hAcc: -1)))
  }

  func testNullIslandIsNotAFix() {
    XCTAssertNil(LocationFix(location(lat: 0, lon: 0)))
    XCTAssertNotNil(LocationFix(location(lat: 0, lon: 1)))  // only the exact (0, 0) placeholder
  }

  func testInvalidCoordinateIsNotAFix() {
    XCTAssertNil(LocationFix(location(lat: 91)))
    XCTAssertNil(LocationFix(location(lon: 181)))
  }

  func testInvalidAltitudeSpeedAndCourseAreOmitted() throws {
    let noAlt = try XCTUnwrap(LocationFix(location(vAcc: -1)))
    XCTAssertNil(noAlt.altM)
    XCTAssertNil(noAlt.altAccuracyM)
    let zeroVAcc = try XCTUnwrap(LocationFix(location(vAcc: 0)))
    XCTAssertNil(zeroVAcc.altM)

    XCTAssertNil(try XCTUnwrap(LocationFix(location(speed: -1))).speedMps)
    XCTAssertNil(try XCTUnwrap(LocationFix(location(speedAcc: -1))).speedMps)
    XCTAssertNil(try XCTUnwrap(LocationFix(location(course: -1))).courseDeg)
    XCTAssertNil(try XCTUnwrap(LocationFix(location(courseAcc: -1))).courseDeg)
    XCTAssertEqual(try XCTUnwrap(LocationFix(location(speed: 0))).speedMps, 0)  // standing still is valid
  }

  // MARK: - LocationFix.contractObject

  func testContractObjectRoundsAndFormatsTime() {
    let f = LocationFix(lat: 32.98571234567, lon: -96.75024444449, accuracyM: 4.96, altM: 180.04,
                        altAccuracyM: 3.25, floor: 2, speedMps: 1.23456, courseDeg: 271.26, t: t0)
    let o = f.contractObject(offsetSeconds: -6 * 3600, ageMs: 850)
    XCTAssertEqual(o["lat"] as? Double, 32.9857123)
    XCTAssertEqual(o["lon"] as? Double, -96.7502444)
    XCTAssertEqual(o["accuracy_m"] as? Double, 5.0)
    XCTAssertEqual(o["alt_m"] as? Double, 180.0)
    XCTAssertEqual(o["alt_accuracy_m"] as? Double, 3.3)
    XCTAssertEqual(o["floor"] as? Int, 2)
    XCTAssertEqual(o["speed_mps"] as? Double, 1.23)
    XCTAssertEqual(o["course_deg"] as? Double, 271.3)
    XCTAssertEqual(o["age_ms"] as? Int, 850)
    XCTAssertEqual(o["t"] as? String, "2026-11-06T15:20:00.000-06:00")
  }

  func testContractObjectOmitsMissingOptionalKeys() {
    let f = LocationFix(lat: 32.9857, lon: -96.7502, accuracyM: 12, t: t0)
    let o = f.contractObject(offsetSeconds: 0)
    XCTAssertEqual(Set(o.keys), ["lat", "lon", "accuracy_m", "t"])
    XCTAssertEqual(o["t"] as? String, "2026-11-06T21:20:00.000Z")
  }

  func testContractObjectIsValidJSON() {
    let o = fix().contractObject(offsetSeconds: 3600, ageMs: 0)
    XCTAssertTrue(JSONSerialization.isValidJSONObject(o))
  }

  // MARK: - LocationFix.isUsableForEvent

  func testEventAccuracyBoundary() {
    let at100 = LocationFix(lat: 1, lon: 1, accuracyM: 100, t: t0)
    let worse = LocationFix(lat: 1, lon: 1, accuracyM: 100.1, t: t0)
    XCTAssertTrue(at100.isUsableForEvent(capturedAt: t0))
    XCTAssertFalse(worse.isUsableForEvent(capturedAt: t0))
  }

  func testEventAgeBoundary() {
    let f = LocationFix(lat: 1, lon: 1, accuracyM: 10, t: t0)
    XCTAssertTrue(f.isUsableForEvent(capturedAt: t0.addingTimeInterval(120)))
    XCTAssertFalse(f.isUsableForEvent(capturedAt: t0.addingTimeInterval(120.001)))
    // A fix slightly after the capture time (clock jitter, out-of-order delivery) counts by |age|.
    XCTAssertTrue(f.isUsableForEvent(capturedAt: t0.addingTimeInterval(-120)))
    XCTAssertFalse(f.isUsableForEvent(capturedAt: t0.addingTimeInterval(-121)))
  }

  func testDistanceIsGreatCircleMetres() {
    let a = fix()
    let b = fix(north: 100)
    XCTAssertEqual(a.distance(to: b), 100, accuracy: 1)
    XCTAssertEqual(a.distance(to: a), 0)
  }
}
