//
// DiagnosticsStoreTests.swift
// Shift Memory
//
// Pins what the Diagnostics numbers mean: the median, percentile and drain definitions, the CSV's
// header and quoting, and the store's bookkeeping (rename, caps, battery dedupe, persistence). A
// manual clock and a throwaway directory keep every test deterministic; nothing touches the
// network, the Photos library or the Keychain.
//

import XCTest
@testable import ShiftMemory

/// A clock the tests advance by hand so timestamps and the battery dedupe window are predictable.
private final class ManualClock {
  var now: Date
  init(_ now: Date) { self.now = now }
  func advance(_ seconds: TimeInterval) { now = now.addingTimeInterval(seconds) }
}

@MainActor
final class DiagnosticsStoreTests: XCTestCase {
  private var directory: URL!
  private var clock: ManualClock!
  /// 2023-11-14T22:13:20Z, a stamp whose ISO-8601 form the CSV test spells out.
  private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

  override func setUp() async throws {
    try await super.setUp()
    directory = FileManager.default.temporaryDirectory
      .appendingPathComponent("DiagnosticsStoreTests-\(UUID().uuidString)", isDirectory: true)
    clock = ManualClock(t0)
  }

  override func tearDown() async throws {
    if let directory { try? FileManager.default.removeItem(at: directory) }
    try await super.tearDown()
  }

  /// A store on the test directory with a 10 ms save debounce and the manual clock.
  private func makeStore() -> DiagnosticsStore {
    let clock = clock!
    return DiagnosticsStore(directory: directory, saveDelay: .milliseconds(10), now: { clock.now })
  }

  // MARK: - Statistics

  func testMedianIsMiddleValueOrMeanOfTheTwoMiddleValues() {
    XCTAssertNil(DiagnosticsStats.median([]))
    XCTAssertEqual(DiagnosticsStats.median([7]), 7)
    XCTAssertEqual(DiagnosticsStats.median([300, 100, 200]), 200)
    XCTAssertEqual(DiagnosticsStats.median([50, 150]), 100)
  }

  func testPercentileIsNearestRank() {
    let ten = (1...10).map { $0 * 100 }
    XCTAssertEqual(DiagnosticsStats.percentile(ten, 0.9), 900)
    XCTAssertEqual(DiagnosticsStats.percentile(ten, 0.5), 500)
    XCTAssertEqual(DiagnosticsStats.percentile(ten, 0), 100)
    XCTAssertEqual(DiagnosticsStats.percentile(ten, 1), 1000)
    XCTAssertEqual(DiagnosticsStats.percentile([300, 100, 200], 0.9), 300)
    XCTAssertEqual(DiagnosticsStats.percentile([42], 0.9), 42)
    XCTAssertNil(DiagnosticsStats.percentile([], 0.9))
  }

  func testLinearSlopePerHour() {
    let points = [
      (at: t0, value: 100.0),
      (at: t0.addingTimeInterval(1800), value: 95.0),
      (at: t0.addingTimeInterval(3600), value: 90.0),
    ]
    XCTAssertEqual(DiagnosticsStats.linearSlopePerHour(points) ?? .nan, -10, accuracy: 1e-9)
    XCTAssertNil(DiagnosticsStats.linearSlopePerHour([points[0]]))
    XCTAssertNil(DiagnosticsStats.linearSlopePerHour([points[0], points[0]]), "no spread in time")
  }

  func testDrainPerHourNeedsTenMinutesAndTwoLevels() {
    XCTAssertNil(DiagnosticsStats.drainPerHour([(at: t0, level: 80), (at: t0.addingTimeInterval(300), level: 79)]),
                 "five minutes is too short")
    XCTAssertNil(DiagnosticsStats.drainPerHour([(at: t0, level: 80), (at: t0.addingTimeInterval(3600), level: 80)]),
                 "a flat line is not a trend yet")
    XCTAssertEqual(
      DiagnosticsStats.drainPerHour([(at: t0, level: 80), (at: t0.addingTimeInterval(3600), level: 76)]) ?? .nan,
      4, accuracy: 1e-9, "80 → 76 in an hour drains 4 points per hour, reported positive")
    XCTAssertNil(DiagnosticsStats.drainPerHour([]))
  }

  // MARK: - CSV

  func testCSVQuoting() {
    XCTAssertEqual(DiagnosticsCSV.quote("plain text"), "plain text")
    XCTAssertEqual(DiagnosticsCSV.quote("a,b"), "\"a,b\"")
    XCTAssertEqual(DiagnosticsCSV.quote("say \"hi\""), "\"say \"\"hi\"\"\"")
    XCTAssertEqual(DiagnosticsCSV.quote("line\r\nbreak"), "\"line\r\nbreak\"")
    XCTAssertEqual(DiagnosticsCSV.quote(""), "")
  }

  func testExportCSVHeaderAndRowQuoting() throws {
    let store = makeStore()
    store.begin(id: "evt-1", source: .sdkCapture)
    store.update(id: "evt-1") {
      $0.requestedAt = Date(timeIntervalSince1970: 1_700_000_000.5)
      $0.bytesAt = Date(timeIntervalSince1970: 1_700_000_001.75)
      $0.bytes = 412_000
      $0.format = .jpeg
      $0.requestedResolution = "full"
      $0.requestedQuality = "high"
      $0.appStateAtArrival = "background"
      $0.error = "timeout after 30 s, \"no bytes\"\nretrying"
    }

    let url = try store.exportCSV()
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    XCTAssertTrue(url.lastPathComponent.hasPrefix("shift-memory-diagnostics-"))
    XCTAssertEqual(url.pathExtension, "csv")

    let text = try String(contentsOf: url, encoding: .utf8)
    let lines = text.components(separatedBy: "\r\n")
    XCTAssertEqual(
      lines[0],
      "id,source,requestedAt,firstProgressAt,bytesAt,captureToBytesMs,bytes,format,requestedResolution,"
        + "requestedQuality,originalPixels,pipelineMs,uploadStartedAt,acceptedAt,uploadToAcceptedMs,inGraphAt,"
        + "bytesToInGraphMs,appStateAtArrival,glassesBattery,phoneBattery,error")
    XCTAssertEqual(DiagnosticsCSV.header, lines[0])
    XCTAssertEqual(DiagnosticsCSV.columns.count, 21)

    // Records are CRLF-separated; the bare newline inside the quoted error stays inside the field
    // (RFC 4180), so splitting on CRLF gives header, one row, then the empty tail.
    XCTAssertEqual(lines.count, 3, "header, the row, then the empty tail")
    let expectedRow = [
      "evt-1", "sdk_capture", "2023-11-14T22:13:20.500Z", "", "2023-11-14T22:13:21.750Z", "1250", "412000",
      "jpeg", "full", "high", "", "", "", "", "", "", "", "background", "", "",
      "\"timeout after 30 s, \"\"no bytes\"\"\nretrying\"",
    ].joined(separator: ",")
    XCTAssertEqual(lines[1], expectedRow)
    XCTAssertEqual(lines[2], "")
  }

  func testExportJSONIncludesSummaryAndRows() throws {
    let store = makeStore()
    store.begin(id: "evt-1", source: .cameraRoll)
    let url = try store.exportJSON()
    addTeardownBlock { try? FileManager.default.removeItem(at: url) }
    XCTAssertEqual(url.pathExtension, "json")

    let object = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
    XCTAssertEqual((object?["summary"] as? [String: Any])?["captureCount"] as? Int, 1)
    XCTAssertEqual((object?["captures"] as? [[String: Any]])?.first?["id"] as? String, "evt-1")
    XCTAssertEqual((object?["captures"] as? [[String: Any]])?.first?["source"] as? String, "camera_roll")
  }

  // MARK: - Rows

  func testBeginIsIdempotentForAKnownId() {
    let store = makeStore()
    store.begin(id: "evt-1", source: .sdkCapture)
    store.update(id: "evt-1") { $0.bytes = 5 }
    let again = store.begin(id: "evt-1", source: .shutterButton)
    XCTAssertEqual(store.captures.count, 1)
    XCTAssertEqual(again.bytes, 5)
    XCTAssertEqual(again.source, .sdkCapture, "the existing row is returned untouched")
  }

  func testRenameMovesTheRow() {
    let store = makeStore()
    store.begin(id: "older", source: .shutterButton)
    store.begin(id: "attempt-1", source: .sdkCapture)
    store.update(id: "attempt-1") { $0.bytes = 123 }

    store.rename(id: "attempt-1", to: "evt-1")
    XCTAssertEqual(store.captures.map(\.id), ["evt-1", "older"], "same place in the list, new id")
    XCTAssertEqual(store.captures.first?.bytes, 123)
    XCTAssertEqual(store.captures.first?.source, .sdkCapture)

    store.update(id: "attempt-1") { $0.bytes = 999 }
    XCTAssertEqual(store.captures.first?.bytes, 123, "the old id no longer addresses anything")
    store.rename(id: "nope", to: "whatever")
    XCTAssertEqual(store.captures.count, 2, "unknown ids are ignored")

    // A stale row already carrying the new id gives way to the renamed one.
    store.begin(id: "attempt-2", source: .sdkCapture)
    store.rename(id: "attempt-2", to: "older")
    XCTAssertEqual(store.captures.map(\.id), ["older", "evt-1"])
    XCTAssertEqual(store.captures.first?.source, .sdkCapture)
  }

  func testCapsHold() {
    let store = makeStore()
    for i in 0..<(DiagnosticsStore.captureCap + 5) { store.begin(id: "c\(i)", source: .sdkCapture) }
    XCTAssertEqual(store.captures.count, DiagnosticsStore.captureCap)
    XCTAssertEqual(store.captures.first?.id, "c\(DiagnosticsStore.captureCap + 4)", "newest first")
    XCTAssertEqual(store.captures.last?.id, "c5", "the five oldest rows were dropped")

    for i in 0..<(DiagnosticsStore.batteryCap + 5) {
      store.recordBattery(glasses: 100 - i % 100, phone: nil)
      clock.advance(61)
    }
    XCTAssertEqual(store.battery.count, DiagnosticsStore.batteryCap)
    XCTAssertEqual(store.battery.first?.at, t0.addingTimeInterval(5 * 61), "the five oldest samples were dropped")
    XCTAssertEqual(store.battery.last?.at, t0.addingTimeInterval(Double(DiagnosticsStore.batteryCap + 4) * 61))
  }

  func testBatteryDedupeSkipsRepeatsWithinAMinute() {
    let store = makeStore()
    store.recordBattery(glasses: nil, phone: nil)
    XCTAssertTrue(store.battery.isEmpty, "nothing to record")

    store.recordBattery(glasses: 80, phone: 55)
    clock.advance(30)
    store.recordBattery(glasses: 80, phone: 55)
    XCTAssertEqual(store.battery.count, 1, "same levels 30 s later are dropped")

    store.recordBattery(glasses: 79, phone: 55)
    XCTAssertEqual(store.battery.count, 2, "a change is always kept")

    clock.advance(60)
    store.recordBattery(glasses: 79, phone: 55)
    XCTAssertEqual(store.battery.count, 3, "same levels a minute later are kept")
    XCTAssertEqual(store.battery.last?.at, t0.addingTimeInterval(90))
  }

  // MARK: - Summary

  func testSummaryGroupsSdkCapturesByResolutionAndQuality() {
    let store = makeStore()
    func capture(_ id: String, _ source: CaptureSource, _ resolution: String, _ quality: String,
                 ms: Int, format: ImageFormat?) {
      store.begin(id: id, source: source)
      store.update(id: id) {
        $0.requestedAt = t0
        $0.bytesAt = t0.addingTimeInterval(Double(ms) / 1000)
        $0.requestedResolution = resolution
        $0.requestedQuality = quality
        $0.format = format
      }
    }
    capture("a", .sdkCapture, "full", "high", ms: 1000, format: .jpeg)
    capture("b", .sdkCapture, "full", "high", ms: 3000, format: .jpeg)
    capture("c", .sdkCapture, "full", "high", ms: 2000, format: .jpeg)
    capture("d", .sdkCapture, "medium", "medium", ms: 500, format: .heic)
    capture("e", .sdkCapture, "medium", "medium", ms: 1500, format: .heic)
    capture("f", .shutterButton, "full", "high", ms: 9000, format: nil)
    store.begin(id: "g", source: .sdkCapture)   // requested, no bytes yet: counted, not timed
    store.update(id: "a") { $0.uploadStartedAt = t0.addingTimeInterval(5); $0.acceptedAt = t0.addingTimeInterval(5.5) }
    store.update(id: "b") {
      $0.uploadStartedAt = t0.addingTimeInterval(5)
      $0.acceptedAt = t0.addingTimeInterval(6.5)
      $0.inGraphAt = t0.addingTimeInterval(13)
    }

    let s = store.summary
    XCTAssertEqual(s.captureCount, 7)
    XCTAssertEqual(s.bySource, ["sdk_capture": 6, "shutter_button": 1])
    XCTAssertEqual(s.byFormat, ["jpeg": 3, "heic": 2, "unknown": 2])
    XCTAssertEqual(s.captureToBytesBySetting.count, 2, "the shutter photo is not an sdk capture")
    XCTAssertEqual(s.captureToBytesBySetting["full/high"], LatencyStats(count: 3, medianMs: 2000, p90Ms: 3000))
    XCTAssertEqual(s.captureToBytesBySetting["medium/medium"], LatencyStats(count: 2, medianMs: 1000, p90Ms: 1500))
    XCTAssertEqual(s.uploadToAcceptedMedianMs, 1000, "median of 500 and 1500")
    XCTAssertEqual(s.bytesToInGraphMedianMs, 10_000, "b: bytes at +3 s, in graph at +13 s")
    XCTAssertNil(s.sessionStartFailureRate)
    XCTAssertNil(s.photoStartFailureRate)
    XCTAssertNil(s.glassesDrainPerHour)
    XCTAssertEqual(s.shutterBackgrounded, 0)
  }

  func testFailureRatesAndShutterCounts() {
    let store = makeStore()
    store.noteSessionStart(success: true, ms: 1200, error: nil)
    store.noteSessionStart(success: false, ms: nil, error: "camera setup failed")
    store.noteSessionStart(success: true, ms: 900, error: nil)
    store.noteSessionStart(success: true, ms: 1000, error: nil)
    store.notePhotoStart(success: false, ms: nil)
    store.noteShutterArrival(foreground: false)
    store.noteShutterArrival(foreground: false)
    store.noteShutterArrival(foreground: true)

    let s = store.summary
    XCTAssertEqual(s.sessionStartFailureRate ?? -1, 0.25, accuracy: 1e-9)
    XCTAssertEqual(s.photoStartFailureRate ?? -1, 1, accuracy: 1e-9)
    XCTAssertEqual(s.shutterBackgrounded, 2)
    XCTAssertEqual(s.shutterForeground, 1)
    XCTAssertEqual(store.session.sessionStartAttempts, 4)
    XCTAssertEqual(store.session.lastSessionError, "camera setup failed")
    XCTAssertEqual(store.session.lastSessionStartMs, 1000)
    XCTAssertEqual(store.session.photoStartFailures, 1)
  }

  func testSummaryReportsGlassesDrain() {
    let store = makeStore()
    store.recordBattery(glasses: 90, phone: 70)
    clock.advance(1800)
    store.recordBattery(glasses: 87, phone: 69)
    clock.advance(1800)
    store.recordBattery(glasses: 84, phone: nil)
    XCTAssertEqual(store.summary.glassesDrainPerHour ?? .nan, 6, accuracy: 1e-9)
  }

  // MARK: - Persistence

  func testFlushThenReloadRestoresState() async throws {
    let store = makeStore()
    store.begin(id: "evt-1", source: .shutterButton)
    store.update(id: "evt-1") {
      $0.bytesAt = Date(timeIntervalSince1970: 1_700_000_000.5)
      $0.appStateAtArrival = "background"
      $0.glassesBattery = 77
    }
    store.noteShutterArrival(foreground: false)
    store.recordBattery(glasses: 77, phone: 61)
    await store.flush()
    XCTAssertNil(store.lastSaveError)
    XCTAssertTrue(FileManager.default.fileExists(atPath: directory.appendingPathComponent(DiagnosticsStore.fileName).path))

    let reloaded = makeStore()
    XCTAssertEqual(reloaded.captures, store.captures)
    XCTAssertEqual(reloaded.session, store.session)
    XCTAssertEqual(reloaded.battery, store.battery)
    XCTAssertEqual(reloaded.captures.first?.bytesAt, Date(timeIntervalSince1970: 1_700_000_000.5))
    XCTAssertEqual(reloaded.session.shutterPhotosWhileBackgrounded, 1)
  }

  func testDebouncedSaveWritesWithoutFlush() async throws {
    let store = makeStore()
    store.begin(id: "evt-1", source: .sdkCapture)
    let url = directory.appendingPathComponent(DiagnosticsStore.fileName)
    var polls = 0
    while !FileManager.default.fileExists(atPath: url.path), polls < 100 {
      try await Task.sleep(for: .milliseconds(20))
      polls += 1
    }
    XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "the 10 ms debounce should have fired")
    XCTAssertEqual(DiagnosticsFile.read(url)?.captures.first?.id, "evt-1")
  }

  func testMissingOrCorruptFileMeansAnEmptyStore() throws {
    XCTAssertTrue(makeStore().captures.isEmpty)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try Data("not json".utf8).write(to: directory.appendingPathComponent(DiagnosticsStore.fileName))
    let store = makeStore()
    XCTAssertTrue(store.captures.isEmpty)
    XCTAssertEqual(store.session, SessionMetrics())
  }

  func testResetClearsEverything() async {
    let store = makeStore()
    store.begin(id: "evt-1", source: .sdkCapture)
    store.noteSessionStart(success: false, ms: nil, error: "x")
    store.recordBattery(glasses: 50, phone: 50)
    store.reset()
    XCTAssertTrue(store.captures.isEmpty)
    XCTAssertEqual(store.session, SessionMetrics())
    XCTAssertTrue(store.battery.isEmpty)
    await store.flush()
    XCTAssertTrue(makeStore().captures.isEmpty, "the empty state was written")
  }
}
