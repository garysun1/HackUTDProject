//
// TrackPipelineTests.swift
// Shift Memory
//
// The shift track pipeline (issue #20): the disk-backed TrackStore (ordering, per-shift batches,
// capacity, persistence across relaunch, torn last line), the `track_json` body the uploader sends,
// and the GeoJSON export the console and the share sheet read.
//

import XCTest
@testable import ShiftMemory

final class TrackPipelineTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appending(path: "TrackPipelineTests-\(UUID().uuidString)", directoryHint: .isDirectory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  private let t0 = Date(timeIntervalSince1970: 1_794_000_000)

  private func fix(_ i: Int, lat: Double = 32.9858, lon: Double = -96.7501, alt: Double? = nil) -> LocationFix {
    LocationFix(lat: lat + Double(i) * 0.0001, lon: lon, accuracyM: 5, altM: alt, t: t0.addingTimeInterval(Double(i) * 10))
  }

  // MARK: - Store

  func testBatchIsOldestShiftInTimeOrderAndConfirmDropsIt() async {
    let store = TrackStore(directory: directory)
    await store.mark(TrackMark.shiftStart, shiftId: "A", at: t0)
    await store.append(fix(2), shiftId: "A")
    await store.append(fix(1), shiftId: "A")   // recorded late, earlier fix time
    await store.append(fix(3), shiftId: "B")
    await store.append(fix(4), shiftId: "A")
    let pending = await store.pendingCount()
    XCTAssertEqual(pending, 5)

    guard let first = await store.nextBatch() else { return XCTFail("expected a batch") }
    XCTAssertEqual(first.shiftId, "A")
    XCTAssertEqual(first.points.map(\.fix.t), [fix(1).t, fix(2).t, fix(4).t])
    XCTAssertTrue(first.points.allSatisfy { $0.shiftId == "A" })
    XCTAssertEqual(first.marks.map(\.kind), [TrackMark.shiftStart])
    XCTAssertEqual(first.pointSeqs.count, 3)
    XCTAssertEqual(first.markSeqs.count, 1)

    await store.confirm(first)
    let afterFirst = await store.pendingCount()
    XCTAssertEqual(afterFirst, 1)
    guard let second = await store.nextBatch() else { return XCTFail("expected shift B") }
    XCTAssertEqual(second.shiftId, "B")
    XCTAssertEqual(second.points.map(\.fix), [fix(3)])
    await store.confirm(second)
    let none = await store.nextBatch()
    XCTAssertNil(none)
    let empty = await store.pendingCount()
    XCTAssertEqual(empty, 0)
  }

  func testBatchRespectsMaxPointsAndHoldsLaterMarks() async {
    let store = TrackStore(directory: directory)
    for i in 0..<5 { await store.append(fix(i), shiftId: "A") }
    await store.mark(TrackMark.shiftEnd, shiftId: "A", at: fix(4).t)

    guard let first = await store.nextBatch(maxPoints: 2) else { return XCTFail("expected a batch") }
    XCTAssertEqual(first.points.map(\.fix), [fix(0), fix(1)])
    XCTAssertTrue(first.marks.isEmpty, "shift_end must not be sent ahead of the points before it")
    await store.confirm(first)

    guard let second = await store.nextBatch(maxPoints: 10) else { return XCTFail("expected the rest") }
    XCTAssertEqual(second.points.map(\.fix), [fix(2), fix(3), fix(4)])
    XCTAssertEqual(second.marks.map(\.kind), [TrackMark.shiftEnd])
  }

  func testCapacityDropsOldestPendingPointsButKeepsHistory() async {
    let store = TrackStore(directory: directory, capacity: 5)
    for i in 0..<8 { await store.append(fix(i), shiftId: "A") }
    let pending = await store.pendingCount()
    XCTAssertEqual(pending, 5)
    let batch = await store.nextBatch()
    XCTAssertEqual(batch?.points.map(\.fix), (3..<8).map { fix($0) })
    let recorded = await store.recordedCount(shiftId: "A")
    XCTAssertEqual(recorded, 8)

    // The drop survives a relaunch.
    let reopened = TrackStore(directory: directory, capacity: 5)
    let reopenedBatch = await reopened.nextBatch()
    XCTAssertEqual(reopenedBatch?.points.map(\.fix), (3..<8).map { fix($0) })
  }

  func testPendingAndHistorySurviveReinit() async {
    do {
      let store = TrackStore(directory: directory)
      await store.mark(TrackMark.shiftStart, shiftId: "A", at: t0)
      for i in 0..<4 { await store.append(fix(i, alt: 180.5), shiftId: "A") }
      let batch = await store.nextBatch(maxPoints: 2)
      await store.confirm(batch!)
    }
    let store = TrackStore(directory: directory)
    let pending = await store.pendingCount()
    XCTAssertEqual(pending, 2)
    let batch = await store.nextBatch()
    XCTAssertEqual(batch?.points.map(\.fix), [fix(2, alt: 180.5), fix(3, alt: 180.5)])
    let history = await store.history(shiftId: "A")
    XCTAssertEqual(history.points.map(\.fix), (0..<4).map { fix($0, alt: 180.5) })
    XCTAssertEqual(history.marks, [TrackMark(shiftId: "A", kind: TrackMark.shiftStart, t: t0)])

    // New items after a relaunch get fresh sequence numbers (no collision with pending ones).
    await store.append(fix(9), shiftId: "A")
    let all = await store.nextBatch()
    XCTAssertEqual(all.map { Set($0.pointSeqs).count }, 3)
  }

  func testTruncatedLastLineIsSkippedAndNextAppendIsReadable() async throws {
    do {
      let store = TrackStore(directory: directory)
      await store.append(fix(0), shiftId: "A")
      await store.append(fix(1), shiftId: "A")
    }
    // Simulate a crash mid-write in both files.
    for url in [TrackStore.journalURL(directory: directory), TrackStore.historyURL(directory: directory, shiftId: "A")] {
      let handle = try FileHandle(forWritingTo: url)
      try handle.seekToEnd()
      try handle.write(contentsOf: Data(#"{"op":"p","seq":3,"shift":"A","fix":{"lat":32."#.utf8))
      try handle.close()
    }
    do {
      let store = TrackStore(directory: directory)
      let pending = await store.pendingCount()
      XCTAssertEqual(pending, 2)
      let recorded = await store.recordedCount(shiftId: "A")
      XCTAssertEqual(recorded, 2)
      await store.append(fix(2), shiftId: "A")
    }
    let store = TrackStore(directory: directory)
    let batch = await store.nextBatch()
    XCTAssertEqual(batch?.points.map(\.fix), [fix(0), fix(1), fix(2)])
    let history = await store.history(shiftId: "A")
    XCTAssertEqual(history.points.map(\.fix), [fix(0), fix(1), fix(2)])
  }

  func testHistoryKeepsConfirmedPointsAndShiftIdsAreListed() async {
    let store = TrackStore(directory: directory)
    for i in 0..<3 { await store.append(fix(i), shiftId: "shift/one") }
    let batch = await store.nextBatch()
    await store.confirm(batch!)
    let pending = await store.pendingCount()
    XCTAssertEqual(pending, 0)
    let history = await store.history(shiftId: "shift/one")
    XCTAssertEqual(history.points.count, 3)
    let ids = await store.shiftIds()
    XCTAssertEqual(ids, ["shift/one"])

    await store.clearHistory(olderThan: Date().addingTimeInterval(60))
    let cleared = await store.shiftIds()
    XCTAssertEqual(cleared, [])
    let count = await store.recordedCount(shiftId: "shift/one")
    XCTAssertEqual(count, 0)
  }

  func testClearHistoryKeepsShiftsStillUploading() async {
    let store = TrackStore(directory: directory)
    await store.append(fix(0), shiftId: "A")
    await store.clearHistory(olderThan: Date().addingTimeInterval(60))
    let ids = await store.shiftIds()
    XCTAssertEqual(ids, ["A"])
  }

  // MARK: - Uploader body

  func testTrackJSONKeyOrderAndContractNames() throws {
    let fixA = LocationFix(lat: 32.98581234, lon: -96.75012341, accuracyM: 4.23, altM: 181.26, altAccuracyM: 3,
                           floor: 2, speedMps: 1.234, courseDeg: 90.04, t: t0)
    let fixB = LocationFix(lat: 32.9859, lon: -96.7502, accuracyM: 8, t: t0.addingTimeInterval(30))
    let batch = TrackBatch(
      shiftId: "S1",
      points: [TrackPoint(shiftId: "S1", fix: fixA), TrackPoint(shiftId: "S1", fix: fixB)],
      marks: [TrackMark(shiftId: "S1", kind: "shift_start", t: t0)],
      pointSeqs: [1, 2], markSeqs: [3]
    )
    let context = TrackUploader.Context(deviceId: "dev-1", ingestToken: "tok", appVersion: "0.3.0")
    let tz = TimeZone(secondsFromGMT: -6 * 3600)!
    let json = TrackUploader.trackJSON(context: context, batch: batch, timeZone: tz)

    let topKeys = ["\"device_id\"", "\"shift_id\"", "\"ingest_token\"", "\"app_version\"", "\"points\"", "\"marks\""]
    let positions = topKeys.map { json.range(of: $0)?.lowerBound }
    XCTAssertFalse(positions.contains(nil), json)
    XCTAssertEqual(positions.compactMap { $0 }, positions.compactMap { $0 }.sorted(), "top-level key order")
    XCTAssertTrue(json.hasPrefix(#"{"device_id":"dev-1","shift_id":"S1","ingest_token":"tok","app_version":"0.3.0","points":[{"t":"#), json)
    XCTAssertTrue(json.contains(#""lat":32.9858123,"lon":-96.7501234,"accuracy_m":4.2,"alt_m":181.3,"floor":2,"speed_mps":1.23,"course_deg":90}"#), json)
    XCTAssertFalse(json.contains("age_ms"))
    XCTAssertFalse(json.contains("alt_accuracy_m"), "not a track point key in the contract")

    let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    XCTAssertEqual(Set(object.keys), ["device_id", "shift_id", "ingest_token", "app_version", "points", "marks"])
    let points = try XCTUnwrap(object["points"] as? [[String: Any]])
    XCTAssertEqual(points.count, 2)
    XCTAssertEqual(points[0]["t"] as? String, EventEnvelope.iso8601(t0, offsetSeconds: -6 * 3600))
    XCTAssertTrue((points[0]["t"] as? String)?.hasSuffix("-06:00") == true)
    XCTAssertEqual(Set(points[1].keys), ["t", "lat", "lon", "accuracy_m"])
    let marks = try XCTUnwrap(object["marks"] as? [[String: Any]])
    XCTAssertEqual(marks.first?["kind"] as? String, "shift_start")
    XCTAssertEqual(marks.first?["t"] as? String, EventEnvelope.iso8601(t0, offsetSeconds: -6 * 3600))
  }

  func testTrackJSONEscapesStrings() throws {
    let batch = TrackBatch(shiftId: "a\"b", points: [], marks: [], pointSeqs: [], markSeqs: [])
    let context = TrackUploader.Context(deviceId: "d/1", ingestToken: "t\\k", appVersion: "1")
    let json = TrackUploader.trackJSON(context: context, batch: batch)
    let object = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    XCTAssertEqual(object["shift_id"] as? String, "a\"b")
    XCTAssertEqual(object["device_id"] as? String, "d/1")
    XCTAssertEqual(object["ingest_token"] as? String, "t\\k")
    XCTAssertEqual((object["points"] as? [Any])?.count, 0)
  }

  func testBackoffDoublesAndCaps() {
    XCTAssertEqual(TrackUploader.backoff(failures: 1), 5)
    XCTAssertEqual(TrackUploader.backoff(failures: 2), 10)
    XCTAssertEqual(TrackUploader.backoff(failures: 7), 300)
    XCTAssertEqual(TrackUploader.backoff(failures: 50), 300)
  }

  func testNumbersNeverUseExponentNotation() {
    XCTAssertEqual(TrackJSONText.number(0.00001), "0.00001")
    XCTAssertEqual(TrackJSONText.number(-0.0000123), "-0.0000123")
    XCTAssertEqual(TrackJSONText.number(1e-7), "0.0000001")
    XCTAssertEqual(TrackJSONText.number(1e16), "10000000000000000")
    XCTAssertEqual(TrackJSONText.number(1.5e20), "150000000000000000000")
    XCTAssertEqual(TrackJSONText.number(32.7767), "32.7767")
    XCTAssertEqual(TrackJSONText.number(-96.7501234), "-96.7501234")
    XCTAssertEqual(TrackJSONText.number(-0.0), "0")
    XCTAssertEqual(TrackJSONText.number(3), "3")
    XCTAssertEqual(TrackJSONText.number(.nan), "null")
    XCTAssertEqual(TrackJSONText.number(.infinity), "null")
    for value in [0.00001, -0.0000123, 1e-7, 1e16, 1.5e20, 123.456, 5e-324] {
      XCTAssertEqual(Double(TrackJSONText.number(value)), value, "round trip \(value)")
    }
    XCTAssertEqual(TrackJSONText.fragment(1), "1")
    XCTAssertEqual(TrackJSONText.fragment(true), "true")
    XCTAssertEqual(TrackJSONText.fragment(NSNumber(value: 1)), "1")
    XCTAssertEqual(TrackJSONText.fragment(NSNumber(value: true)), "true")
  }

  func testTrackPointNearEquatorHasNoExponent() throws {
    let fix = LocationFix(lat: 0.00001, lon: -0.0000123, accuracyM: 5, t: t0)
    let batch = TrackBatch(shiftId: "S", points: [TrackPoint(shiftId: "S", fix: fix)], marks: [], pointSeqs: [1], markSeqs: [])
    let json = TrackUploader.trackJSON(context: .init(deviceId: "d", ingestToken: "t", appVersion: "1"), batch: batch)
    XCTAssertTrue(json.contains(#""lat":0.00001,"lon":-0.0000123"#), json)
    XCTAssertFalse(json.contains("e-"), json)
  }

  func testStoreRefusesUnknownMarkKindsAndScrubsNonFiniteOptionals() async throws {
    let store = TrackStore(directory: directory)
    await store.mark("lunch", shiftId: "A", at: t0)
    let none = await store.pendingCount()
    XCTAssertEqual(none, 0)

    let bad = LocationFix(lat: 32.9, lon: -96.7, accuracyM: 5, altM: .nan, altAccuracyM: 3, speedMps: .infinity, courseDeg: 10, t: t0)
    await store.append(bad, shiftId: "A")
    let reopened = TrackStore(directory: directory)
    let maybeBatch = await reopened.nextBatch()
    let batch = try XCTUnwrap(maybeBatch)
    XCTAssertEqual(batch.points.count, 1, "the point reached disk")
    XCTAssertNil(batch.points[0].fix.altM)
    XCTAssertNil(batch.points[0].fix.speedMps)
    XCTAssertEqual(batch.points[0].fix.courseDeg, 10)
  }

  // MARK: - GeoJSON

  private func geo(points: [TrackPoint], marks: [TrackMark] = [], photos: [PhotoPin] = []) throws -> [String: Any] {
    let data = ShiftGeoJSON.featureCollection(shiftId: "S1", deviceId: "dev-1", wearer: "Maria", points: points,
                                              marks: marks, photos: photos, timeZone: TimeZone(secondsFromGMT: -6 * 3600)!)
    return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
  }

  func testGeoJSONTrackPhotoAndMarks() throws {
    let points = (0..<3).map { TrackPoint(shiftId: "S1", fix: fix($0)) }
    let photoFix = LocationFix(lat: 32.9860, lon: -96.7500, accuracyM: 6.04, t: t0.addingTimeInterval(15))
    let photo = PhotoPin(eventId: "e1", t: t0.addingTimeInterval(15), fix: photoFix, source: "glasses", note: "rack 12", summary: nil)
    let marks = [TrackMark(shiftId: "S1", kind: "shift_start", t: t0), TrackMark(shiftId: "S1", kind: "shift_end", t: fix(2).t)]
    let root = try geo(points: points, marks: marks, photos: [photo])

    XCTAssertEqual(root["type"] as? String, "FeatureCollection")
    let features = try XCTUnwrap(root["features"] as? [[String: Any]])
    XCTAssertEqual(features.count, 4)
    for feature in features { XCTAssertEqual(feature["type"] as? String, "Feature") }

    let track = try XCTUnwrap(features.first { ($0["geometry"] as? [String: Any])?["type"] as? String == "LineString" })
    let line = try XCTUnwrap(track["geometry"] as? [String: Any])
    let coords = try XCTUnwrap(line["coordinates"] as? [[Double]])
    XCTAssertEqual(coords.count, 3)
    XCTAssertEqual(coords[0][0], -96.7501, accuracy: 1e-9, "longitude first")
    XCTAssertEqual(coords[0][1], 32.9858, accuracy: 1e-9, "latitude second")
    XCTAssertTrue(coords.allSatisfy { $0.count == 2 })
    let props = try XCTUnwrap(track["properties"] as? [String: Any])
    XCTAssertEqual(props["shift_id"] as? String, "S1")
    XCTAssertEqual(props["device_id"] as? String, "dev-1")
    XCTAssertEqual(props["wearer"] as? String, "Maria")
    XCTAssertEqual(props["point_count"] as? Int, 3)
    XCTAssertEqual(props["start"] as? String, EventEnvelope.iso8601(t0, offsetSeconds: -6 * 3600))
    XCTAssertEqual(props["end"] as? String, EventEnvelope.iso8601(fix(2).t, offsetSeconds: -6 * 3600))
    let distance = try XCTUnwrap(props["distance_m"] as? Double)
    XCTAssertEqual(distance, 22.2, accuracy: 0.5)   // 2 × 0.0001° latitude ≈ 2 × 11.1 m

    let photoFeature = try XCTUnwrap(features.first { ($0["properties"] as? [String: Any])?["kind"] as? String == "photo" })
    let photoProps = try XCTUnwrap(photoFeature["properties"] as? [String: Any])
    XCTAssertEqual(photoProps["event_id"] as? String, "e1")
    XCTAssertEqual(photoProps["source"] as? String, "glasses")
    XCTAssertEqual(photoProps["note"] as? String, "rack 12")
    XCTAssertTrue(photoProps["summary"] is NSNull)
    XCTAssertEqual(photoProps["accuracy_m"] as? Double, 6.0)
    XCTAssertTrue((photoProps["t"] as? String)?.hasSuffix("-06:00") == true)
    let photoGeometry = try XCTUnwrap(photoFeature["geometry"] as? [String: Any])
    XCTAssertEqual(photoGeometry["type"] as? String, "Point")
    XCTAssertEqual(photoGeometry["coordinates"] as? [Double], [-96.75, 32.986])

    let kinds = features.compactMap { ($0["properties"] as? [String: Any])?["kind"] as? String }
    XCTAssertTrue(kinds.contains("shift_start"))
    XCTAssertTrue(kinds.contains("shift_end"))
  }

  func testGeoJSONSinglePointTrackIsAPointAndEmptyTrackIsOmitted() throws {
    let single = try geo(points: [TrackPoint(shiftId: "S1", fix: fix(0))])
    let features = try XCTUnwrap(single["features"] as? [[String: Any]])
    XCTAssertEqual(features.count, 1)
    let geometry = try XCTUnwrap(features[0]["geometry"] as? [String: Any])
    XCTAssertEqual(geometry["type"] as? String, "Point")
    XCTAssertEqual((geometry["coordinates"] as? [Double])?.count, 2)

    let empty = try geo(points: [], marks: [TrackMark(shiftId: "S1", kind: "shift_start", t: t0)])
    XCTAssertEqual((empty["features"] as? [Any])?.count, 0)
  }

  func testGeoJSONIsPrettyPrintedWithSortedKeysAndShortNumbers() {
    let data = ShiftGeoJSON.featureCollection(shiftId: "S1", deviceId: "d", wearer: nil,
                                              points: [TrackPoint(shiftId: "S1", fix: fix(0)), TrackPoint(shiftId: "S1", fix: fix(1))],
                                              marks: [], photos: [])
    let text = String(decoding: data, as: UTF8.self)
    XCTAssertTrue(text.hasPrefix("{\n  \"features\": ["), text)
    XCTAssertTrue(text.contains("[-96.7501, 32.9858]"), text)
    XCTAssertTrue(text.contains("\"wearer\": null"), text)
  }
}
