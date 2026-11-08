//
// EventEnvelopeLocationTests.swift
// Shift Memory
//
// Contract v3.1 (issues #19/#20): `event_json` carries `shift_id` and `location` only when known,
// in a fixed key order, with plain decimal numbers; older payloads are unchanged.
//

import XCTest
@testable import ShiftMemory

final class EventEnvelopeLocationTests: XCTestCase {
  private let offset = -6 * 3600
  private let captured = Date(timeIntervalSince1970: 1_794_102_000)

  private func event(location: LocationFix?, shiftId: String?) -> CaptureEvent {
    CaptureEvent(id: "e1", deviceId: "edward-iphone", clientT: captured, clientTZOffsetSeconds: offset,
                 source: .shutterButton, width: 1600, height: 1200, jpegBytes: 1, location: location, shiftId: shiftId)
  }

  private func object(_ json: String) throws -> [String: Any] {
    try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
  }

  func testNoLocationNoShiftLeavesV3PayloadUnchanged() throws {
    let json = EventEnvelope.json(for: event(location: nil, shiftId: nil), ingestToken: "tok", appVersion: "0.1.0")
    XCTAssertFalse(json.contains("location"))
    XCTAssertFalse(json.contains("shift_id"))
    XCTAssertTrue(json.hasPrefix(#"{"event_id":"e1","device_id":"edward-iphone","client_t":"#))
  }

  func testLocationAndShiftAreWrittenWithContractKeys() throws {
    let fix = LocationFix(lat: 32.98589012345, lon: -96.75023, accuracyM: 6.14, altM: 192.44, altAccuracyM: 3.0,
                          floor: 2, speedMps: 0.613, courseDeg: 359.97, t: captured.addingTimeInterval(-1.8))
    let json = EventEnvelope.json(for: event(location: fix, shiftId: "s-1"), ingestToken: "tok", appVersion: "0.1.0")
    let o = try object(json)
    XCTAssertEqual(o["shift_id"] as? String, "s-1")
    let loc = try XCTUnwrap(o["location"] as? [String: Any])
    XCTAssertEqual(loc["lat"] as? Double, 32.9858901)
    XCTAssertEqual(loc["lon"] as? Double, -96.75023)
    XCTAssertEqual(loc["accuracy_m"] as? Double, 6.1)
    XCTAssertEqual(loc["alt_m"] as? Double, 192.4)
    XCTAssertEqual(loc["floor"] as? Int, 2)
    XCTAssertEqual(loc["speed_mps"] as? Double, 0.61)
    XCTAssertEqual(loc["course_deg"] as? Double, 0, "360.0 wraps to 0")
    XCTAssertEqual(loc["age_ms"] as? Int, 1800)
    XCTAssertEqual(loc["t"] as? String, EventEnvelope.iso8601(fix.t, offsetSeconds: offset))
    // Key order: shift_id and location sit between wearer/clock fields and the token.
    let s = try XCTUnwrap(json.range(of: #""shift_id""#)), l = try XCTUnwrap(json.range(of: #""location""#)),
        t = try XCTUnwrap(json.range(of: #""ingest_token""#))
    XCTAssertTrue(s.lowerBound < l.lowerBound && l.lowerBound < t.lowerBound)
    XCTAssertTrue(json.contains(#""location":{"lat":32.9858901,"lon":-96.75023,"accuracy_m":6.1,"#), json)
  }

  func testCoordinatesNearZeroAreNeverInExponentNotation() throws {
    let fix = LocationFix(lat: 0.00001, lon: -0.0000123, accuracyM: 5, t: captured)
    let json = EventEnvelope.json(for: event(location: fix, shiftId: nil), ingestToken: "tok", appVersion: "0.1.0")
    XCTAssertFalse(json.lowercased().contains("e-"), json)
    XCTAssertTrue(json.contains(#""lat":0.00001"#), json)
  }

  func testUsableForEventBoundaries() {
    let ok = LocationFix(lat: 1, lon: 1, accuracyM: 100, t: captured.addingTimeInterval(-120))
    XCTAssertTrue(ok.isUsableForEvent(capturedAt: captured))
    XCTAssertFalse(LocationFix(lat: 1, lon: 1, accuracyM: 100.1, t: captured).isUsableForEvent(capturedAt: captured))
    XCTAssertFalse(LocationFix(lat: 1, lon: 1, accuracyM: 5, t: captured.addingTimeInterval(-120.5)).isUsableForEvent(capturedAt: captured))
  }

  func testOldPersistedEventsStillDecode() throws {
    // An event JSON written by the previous build (no location / shiftId keys).
    var e = event(location: nil, shiftId: nil)
    e.stage = .queued
    let data = try JSONEncoder().encode(e)
    var dict = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    dict.removeValue(forKey: "location"); dict.removeValue(forKey: "shiftId")
    let old = try JSONSerialization.data(withJSONObject: dict)
    let decoded = try JSONDecoder().decode(CaptureEvent.self, from: old)
    XCTAssertNil(decoded.location)
    XCTAssertNil(decoded.shiftId)
  }
}

/// Which fix places a photo: the newest at or before the press, else the earliest after it.
@MainActor
final class PhotoPlacementTests: XCTestCase {
  private let press = Date(timeIntervalSince1970: 1_794_102_000)
  private func fix(_ dt: TimeInterval, acc: Double = 5, lat: Double = 32.9) -> LocationFix {
    LocationFix(lat: lat, lon: -96.7, accuracyM: acc, t: press.addingTimeInterval(dt))
  }

  func testPrefersNewestFixBeforeThePress() {
    let chosen = AppModel.bestFix(for: press, among: [fix(-30, lat: 1), fix(-3, lat: 2), fix(10, lat: 3)])
    XCTAssertEqual(chosen?.lat, 2)
  }

  func testToleratesTwoSecondsOfDeliveryJitter() {
    XCTAssertEqual(AppModel.bestFix(for: press, among: [fix(-20, lat: 1), fix(1.5, lat: 2)])?.lat, 2)
  }

  func testFallsBackToEarliestLaterFix() {
    XCTAssertEqual(AppModel.bestFix(for: press, among: [fix(8, lat: 1), fix(40, lat: 2)])?.lat, 1)
  }

  func testSkipsUnusableFixes() {
    XCTAssertNil(AppModel.bestFix(for: press, among: [fix(-200), fix(-1, acc: 150)]))
  }
}
