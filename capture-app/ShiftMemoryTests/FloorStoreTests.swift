//
// FloorStoreTests.swift
// Shift Memory
//
// Pins how the floor map reads the registry and how it notices the memory changing: FloorGeometry on
// the real registry location strings, FloorMap's rack grouping, and the snapshot diff that drives the
// extinguish and pulse animations (open → resolved, new events on an asset, nothing on first load).
// Everything is built from literal snapshots; nothing touches the network.
//

import XCTest
@testable import ShiftMemory

final class FloorGeometryTests: XCTestCase {
  func testPlaceRowAndRack() {
    let p = FloorGeometry.place("Row 1 / Rack R12")
    XCTAssertEqual(p.row, "Row 1")
    XCTAssertEqual(p.rack, "R12")
    XCTAssertNil(p.zone)
    XCTAssertFalse(p.isRowEnd)
  }

  func testPlaceRowOnly() {
    let p = FloorGeometry.place("Row 1")
    XCTAssertEqual(p.row, "Row 1")
    XCTAssertNil(p.rack)
    XCTAssertNil(p.zone)
    XCTAssertFalse(p.isRowEnd)
  }

  func testPlaceRowEnd() {
    let p = FloorGeometry.place("Row 1 end")
    XCTAssertEqual(p.row, "Row 1")
    XCTAssertTrue(p.isRowEnd)
    XCTAssertNil(p.rack)
  }

  func testPlaceZone() {
    let p = FloorGeometry.place("Electrical room")
    XCTAssertNil(p.row)
    XCTAssertNil(p.rack)
    XCTAssertEqual(p.zone, "Electrical room")
    XCTAssertEqual(FloorGeometry.place("  ").zone, "Unplaced")
  }

  func testLayoutOfDemoRegistry() {
    let layout = FloorGeometry.layout(FloorFixtures.registry)
    XCTAssertEqual(layout.rows.map(\.row), ["Row 1"])
    XCTAssertEqual(layout.rows.first?.racks, ["R12", "R13"])
    XCTAssertEqual(layout.zones, ["Electrical room"])
  }

  func testLayoutSortsRowsAndRacksNaturally() {
    let assets = [
      FloorFixtures.asset("A", "rack", "Row 10 / Rack R2"),
      FloorFixtures.asset("B", "rack", "Row 2 / Rack R10"),
      FloorFixtures.asset("C", "rack", "Row 2 / Rack R9"),
    ]
    let layout = FloorGeometry.layout(assets)
    XCTAssertEqual(layout.rows.map(\.row), ["Row 2", "Row 10"])
    XCTAssertEqual(layout.rows.first?.racks, ["R9", "R10"])
  }

  func testMapGroupsRackAssetsWithTheirMountedGear() {
    let map = FloorMap.build(FloorFixtures.registry)
    XCTAssertEqual(map.rows.count, 1)
    let row = map.rows[0]
    XCTAssertEqual(row.racks.map(\.title), ["R12", "R13"])
    XCTAssertEqual(row.racks[0].assets.map(\.id), ["R12", "PDU-A", "PDU-B"])   // rack first
    XCTAssertEqual(row.racks[1].assets.map(\.id), ["R13", "SW-CORE-1"])
    XCTAssertEqual(row.ends.map(\.title), ["CRAC-2"])
    XCTAssertEqual(map.zones.map(\.name), ["Electrical room"])
    XCTAssertEqual(map.zones.first?.slots.map(\.title), ["UPS-1"])
  }

  func testMapKeepsARackWithNoRowAsAZone() {
    // FloorGeometry leaves zone nil for "Rack R40" (a rack but no row); the map must still draw it.
    let map = FloorMap.build([FloorFixtures.asset("SRV-9", "server", "Rack R40"),
                              FloorFixtures.asset("UPS-1", "ups", "Electrical room")])
    XCTAssertTrue(map.rows.isEmpty)
    XCTAssertEqual(map.zones.map(\.name), ["Electrical room", "Rack R40"])
    XCTAssertEqual(map.zones.last?.slots.map(\.title), ["SRV-9"])
  }

  func testSymbols() {
    XCTAssertEqual(floorSymbol(forType: "pdu"), "bolt")
    XCTAssertEqual(floorSymbol(forType: "switch"), "network")
    XCTAssertEqual(floorSymbol(forType: "crac"), "snowflake")
    XCTAssertEqual(floorSymbol(forType: "ups"), "battery.100percent")
    XCTAssertEqual(floorSymbol(forType: "rack"), "server.rack")
  }
}

@MainActor
final class FloorStoreDiffTests: XCTestCase {
  private let t0 = Date(timeIntervalSince1970: 1_700_000_000)

  func testFirstSnapshotReportsNothing() {
    let next = FloorFixtures.snapshot(at: t0, issues: [FloorFixtures.issue(1, resolved: true)],
                                      events: [FloorFixtures.event("e1", at: t0)], involves: ["e1": ["pdu_a"]])
    let diff = FloorStore.diff(previous: .empty, next: next, now: t0)
    XCTAssertEqual(diff, FloorStore.Diff())
  }

  func testOpenToResolvedIsReported() {
    let prev = FloorFixtures.snapshot(at: t0, issues: [FloorFixtures.issue(1, resolved: false),
                                                       FloorFixtures.issue(2, resolved: false),
                                                       FloorFixtures.issue(3, resolved: true)])
    let next = FloorFixtures.snapshot(at: t0 + 4, issues: [FloorFixtures.issue(1, resolved: true),
                                                           FloorFixtures.issue(2, resolved: false),
                                                           FloorFixtures.issue(3, resolved: true)])
    let diff = FloorStore.diff(previous: prev, next: next, now: t0 + 4)
    XCTAssertEqual(diff.resolved, [1: t0 + 4])   // 3 was already resolved; 2 is still open
    XCTAssertTrue(diff.touched.isEmpty)
  }

  func testNewIssueThatArrivesResolvedIsNotAnExtinguish() {
    let prev = FloorFixtures.snapshot(at: t0, issues: [])
    let next = FloorFixtures.snapshot(at: t0 + 4, issues: [FloorFixtures.issue(9, resolved: true)])
    XCTAssertTrue(FloorStore.diff(previous: prev, next: next, now: t0 + 4).resolved.isEmpty)
  }

  func testNewEventTouchesInvolvedAndLabelledAssets() {
    let prev = FloorFixtures.snapshot(at: t0, events: [FloorFixtures.event("old", at: t0)],
                                      involves: ["old": ["ups_1"]])
    let next = FloorFixtures.snapshot(
      at: t0 + 4,
      events: [FloorFixtures.event("new", at: t0 + 3), FloorFixtures.event("lab", at: t0 + 2, label: "CRAC unit 2"),
               FloorFixtures.event("old", at: t0)],
      involves: ["new": ["pdu_a"], "old": ["ups_1"]])
    let diff = FloorStore.diff(previous: prev, next: next, now: t0 + 4)
    XCTAssertEqual(Set(diff.touched.keys), ["PDU-A", "CRAC-2"])   // UPS-1's event is not new
    XCTAssertEqual(diff.touched["PDU-A"], t0 + 4)
  }

  func testOverlayMarksLocallyAckedIssuesResolved() {
    let snap = FloorFixtures.snapshot(at: t0, issues: [FloorFixtures.issue(1, resolved: false),
                                                       FloorFixtures.issue(2, resolved: false)])
    let out = FloorStore.overlay(snap, acked: [1: t0 + 1])
    XCTAssertEqual(out.issues.map(\.isResolved), [true, false])
    XCTAssertEqual(out.issues.first?.resolvedAt, t0 + 1)
    XCTAssertEqual(FloorStore.overlay(snap, acked: [:]).issues, snap.issues)
  }

  func testResolvedThisShiftCountsRecentAcks() {
    let store = FloorStore(repository: FloorFixtures.repository, log: { _ in })
    store.apply(FloorFixtures.snapshot(at: t0, issues: [FloorFixtures.issue(1, resolved: false)]), now: t0)
    store.apply(FloorFixtures.snapshot(at: t0 + 4, issues: [FloorFixtures.issue(1, resolved: true)]), now: t0 + 4)
    // The fixture has no acked time; it still counts while the phone remembers it going out.
    XCTAssertEqual(store.resolvedThisShiftCount(now: t0 + 5), 1)
  }

  func testApplyExpiresMarksAndDrivesTileState() {
    let store = FloorStore(repository: FloorFixtures.repository, log: { _ in })
    let open = FloorFixtures.snapshot(at: t0, issues: [FloorFixtures.issue(1, resolved: false)])
    store.apply(open, now: t0)
    let pdu = FloorFixtures.registry.first { $0.id == "PDU-A" }!
    XCTAssertEqual(store.openCount, 1)
    guard case .burning(let issues) = store.state(for: pdu, now: t0) else { return XCTFail("expected burning") }
    XCTAssertEqual(issues.map(\.id), [1])

    store.apply(FloorFixtures.snapshot(at: t0 + 4, issues: [FloorFixtures.issue(1, resolved: true)]), now: t0 + 4)
    XCTAssertEqual(store.openCount, 0)
    XCTAssertEqual(store.recentlyResolved, [1: t0 + 4])
    XCTAssertEqual(store.state(for: pdu, now: t0 + 10), .extinguished(at: t0 + 4))
    XCTAssertEqual(store.state(for: pdu, now: t0 + 25), .idle)

    store.prune(now: t0 + 25)
    XCTAssertTrue(store.recentlyResolved.isEmpty)
  }
}

/// The demo registry (demo/assets.csv) and small builders for snapshots around it.
enum FloorFixtures {
  static func asset(_ id: String, _ type: String, _ location: String, name: String? = nil) -> FloorAsset {
    FloorAsset(id: id, name: name ?? id, type: type, location: location, place: FloorGeometry.place(location))
  }

  static let registry: [FloorAsset] = [
    asset("PDU-A", "pdu", "Row 1 / Rack R12", name: "PDU A (Rack R12)"),
    asset("PDU-B", "pdu", "Row 1 / Rack R12", name: "PDU B (Rack R12)"),
    asset("R12", "rack", "Row 1", name: "Rack R12"),
    asset("R13", "rack", "Row 1", name: "Rack R13"),
    asset("SW-CORE-1", "switch", "Row 1 / Rack R13", name: "Core switch 1"),
    asset("CRAC-2", "crac", "Row 1 end", name: "CRAC unit 2"),
    asset("UPS-1", "ups", "Electrical room", name: "UPS 1"),
  ]

  static let entityToAsset: [String: FloorAsset] = [
    "pdu_a": registry[0], "ups_1": registry[6], "crac_2": registry[5],
  ]

  static func issue(_ id: UInt64, resolved: Bool, entity: String = "pdu_a") -> FloorIssue {
    FloorIssue(id: id, eventId: "e\(id)", at: Date(timeIntervalSince1970: 1_699_999_000), kind: "fault_text",
               text: "PDU A breaker tripped", entityId: entity, entityName: "PDU A", wearerName: "Maria",
               deviceId: "dev-1", isResolved: resolved, resolvedAt: nil)
  }

  static func event(_ id: String, at: Date, label: String? = nil) -> FloorEvent {
    FloorEvent(id: id, deviceId: "dev-1", at: at, clientT: "", source: "glasses", status: "done",
               summary: "photo", note: nil, label: label, location: "")
  }

  static func snapshot(at: Date, issues: [FloorIssue] = [], events: [FloorEvent] = [],
                       involves: [String: Set<String>] = [:]) -> FloorSnapshot {
    FloorSnapshot(fetchedAt: at, assets: registry, issues: issues, events: events, changes: [], wearers: [:],
                  involvesAsset: involves, assetForEntity: entityToAsset)
  }

  /// Never fetched in these tests; the endpoint is unconfigured so any call would fail fast.
  static let repository = FloorRepository(client: IngestClient(endpoint: { BackendEndpoint(host: "", database: "") }))
}
