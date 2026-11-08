//
// BriefingBuilderTests.swift
// Shift Memory
//
// The shift-start briefing from hand-built snapshots: issues land with their place, my own notes
// are not handed back to me, "Handoff:" notes lead, resolutions count as changes, scene changes do
// not, and the spoken script stays short and free of IDs.
//

import XCTest
@testable import ShiftMemory

final class BriefingBuilderTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_794_100_000)
  var since: Date { now.addingTimeInterval(-8 * 3600) }
  let utc = TimeZone(identifier: "UTC")!

  let pdu = FloorAsset(id: "PDU-A", name: "PDU A", type: "pdu", location: "Row 1 / Rack R12",
                       place: FloorGeometry.place("Row 1 / Rack R12"))
  let crac = FloorAsset(id: "CRAC-2", name: "CRAC 2", type: "cooling", location: "Row 1 end",
                        place: FloorGeometry.place("Row 1 end"))
  let ups = FloorAsset(id: "UPS-1", name: "UPS 1", type: "ups", location: "Electrical room",
                       place: FloorGeometry.place("Electrical room"))

  func event(_ id: String, device: String, minutesAgo: Double, note: String? = nil, summary: String = "A photo.") -> FloorEvent {
    FloorEvent(id: id, deviceId: device, at: now.addingTimeInterval(-minutesAgo * 60), clientT: "", source: "glasses",
               status: "in_graph", summary: summary, note: note, label: nil, location: "")
  }

  func issue(_ id: UInt64, event: String, entity: String, name: String, text: String, minutesAgo: Double,
             resolvedMinutesAgo: Double? = nil) -> FloorIssue {
    FloorIssue(id: id, eventId: event, at: now.addingTimeInterval(-minutesAgo * 60), kind: "fault_text", text: text,
               entityId: entity, entityName: name, wearerName: "Gary", deviceId: "gary-phone",
               isResolved: resolvedMinutesAgo != nil,
               resolvedAt: resolvedMinutesAgo.map { now.addingTimeInterval(-$0 * 60) })
  }

  func snapshot(issues: [FloorIssue] = [], events: [FloorEvent] = [], changes: [FloorChange] = [],
                involves: [String: Set<String>] = [:]) -> FloorSnapshot {
    FloorSnapshot(fetchedAt: now, assets: [pdu, crac, ups], issues: issues, events: events.sorted { $0.at > $1.at },
                  changes: changes,
                  wearers: ["gary-phone": FloorWearer(deviceId: "gary-phone", name: "Gary", role: "tech", shift: "night"),
                            "ed-phone": FloorWearer(deviceId: "ed-phone", name: "Edward", role: "tech", shift: "day")],
                  involvesAsset: involves, assetForEntity: ["pdu_a": pdu, "crac_2": crac, "ups_1": ups])
  }

  func build(_ s: FloorSnapshot, handoff: String? = nil) -> Briefing {
    BriefingBuilder.build(snapshot: s, myDeviceId: "ed-phone", myName: "Edward", since: since, now: now,
                          handoffText: handoff, timeZone: utc)
  }

  func testOpenIssueLandsInNeedsYouWithPlace() {
    let s = snapshot(issues: [issue(7, event: "ev-abc123", entity: "pdu_a", name: "PDU A", text: "breaker tripped", minutesAgo: 30)],
                     events: [event("ev-abc123", device: "gary-phone", minutesAgo: 30, note: "smells hot",
                                    summary: "PDU A shows a tripped breaker.")])
    let b = build(s)
    XCTAssertEqual(b.needsYou.count, 1)
    let item = b.needsYou[0]
    XCTAssertEqual(item.place, "Row 1 · Rack R12")
    XCTAssertEqual(item.title, "PDU A: breaker tripped")
    XCTAssertEqual(item.who, "Gary")
    XCTAssertEqual(item.issueId, 7)
    XCTAssertEqual(item.eventId, "ev-abc123")
    XCTAssertTrue(item.detail.contains("PDU A shows a tripped breaker."))
    XCTAssertTrue(item.detail.contains("smells hot"))
    XCTAssertEqual(item.severity, .critical)
    XCTAssertTrue(b.headline.hasPrefix("1 open issue on Row 1."), b.headline)
  }

  func testMyOwnNotesAreNotLeftForMe() {
    let s = snapshot(events: [event("e1", device: "ed-phone", minutesAgo: 10, note: "my own note"),
                              event("e2", device: "gary-phone", minutesAgo: 20, note: "check CRAC filter")])
    let b = build(s)
    XCTAssertEqual(b.leftForYou.map(\.title), ["check CRAC filter"])
    XCTAssertEqual(b.leftForYou.first?.who, "Gary")
  }

  func testHandoffNotesComeFirstWithPrefixStripped() {
    let s = snapshot(events: [event("e1", device: "gary-phone", minutesAgo: 5, note: "fan noisy"),
                              event("e2", device: "gary-phone", minutesAgo: 60, note: "Handoff: watch PDU A tonight")])
    let b = build(s)
    XCTAssertEqual(b.leftForYou.map(\.title), ["watch PDU A tonight", "fan noisy"])
    XCTAssertTrue(b.leftForYou[0].isHandoffNote)
    XCTAssertFalse(b.leftForYou[1].isHandoffNote)
  }

  func testResolvedIssueShowsInChanged() {
    let s = snapshot(issues: [issue(3, event: "e9", entity: "pdu_a", name: "PDU A", text: "breaker tripped",
                                    minutesAgo: 120, resolvedMinutesAgo: 40)])
    let b = build(s)
    XCTAssertTrue(b.needsYou.isEmpty)
    XCTAssertEqual(b.changed.map(\.title), ["Resolved: PDU A"])
    XCTAssertEqual(b.changed.first?.place, "Row 1 · Rack R12")
  }

  func testAssetChangesDedupedAndSceneChangesIgnored() {
    let s = snapshot(events: [event("e1", device: "gary-phone", minutesAgo: 90), event("e2", device: "gary-phone", minutesAgo: 30)],
                     changes: [FloorChange(eventId: "e1", entityId: "pdu_a", attr: "PSU2", from: "OK", to: "WARN"),
                               FloorChange(eventId: "e2", entityId: "pdu_a", attr: "PSU2", from: "WARN", to: "FAULT"),
                               FloorChange(eventId: "e2", entityId: "scene", attr: "lights", from: "on", to: "off"),
                               FloorChange(eventId: "e2", entityId: "door_3", attr: "state", from: "closed", to: "open")])
    let b = build(s)
    XCTAssertEqual(b.changed.map(\.title), ["PSU2: WARN → FAULT"])
  }

  func testQuietListsUnseenAssets() {
    let s = snapshot(events: [event("e1", device: "gary-phone", minutesAgo: 10)], involves: ["e1": ["pdu_a"]])
    XCTAssertEqual(build(s).quiet, ["CRAC 2", "UPS 1"])
  }

  func testEmptyHeadline() {
    let b = build(snapshot())
    XCTAssertEqual(b.headline, "Nothing open. Last shift ended quietly.")
    XCTAssertTrue(b.spokenScript.hasSuffix("Tap Got it when you're ready."))
  }

  func testHandoffTextBecomesLead() {
    let b = build(snapshot(), handoff: "  Quiet night. PDU A was reset at 2 AM.  ")
    XCTAssertEqual(b.leadText, "Quiet night. PDU A was reset at 2 AM.")
    XCTAssertTrue(b.spokenScript.contains("From the handoff"))
  }

  func testSpokenScriptIsShortAndHasNoIds() {
    let issues = (1...6).map { i in
      issue(UInt64(i), event: "evt-\(i)-7f3a9c", entity: "pdu_a", name: "PDU A",
            text: "breaker tripped on outlet bank \(i) see evt-\(i)-7f3a9c", minutesAgo: Double(i * 10))
    }
    let events = (1...6).map { i in
      event("evt-\(i)-7f3a9c", device: "gary-phone", minutesAgo: Double(i * 10),
            note: "Handoff: this is a long note that keeps going and going about the state of rack \(i) and what to watch")
    }
    let b = build(snapshot(issues: issues, events: events))
    let words = b.spokenScript.split(whereSeparator: { $0.isWhitespace }).count
    XCTAssertLessThan(words, 100, b.spokenScript)
    for e in events { XCTAssertFalse(b.spokenScript.contains(e.id), b.spokenScript) }
    XCTAssertFalse(b.spokenScript.contains("issue-"))
    XCTAssertTrue(b.spokenScript.hasPrefix("6 issues need you."), b.spokenScript)
    XCTAssertTrue(b.spokenScript.contains("PM") || b.spokenScript.contains("AM"))
    XCTAssertTrue(b.spokenScript.hasSuffix("Tap Got it when you're ready."))
  }

  func testEventSlightlyAfterNowStillCounts() {
    // Server receive time can be a few seconds ahead of the phone clock.
    let s = snapshot(events: [event("e1", device: "gary-phone", minutesAgo: -0.2, note: "just now")])
    XCTAssertEqual(build(s).leftForYou.map(\.title), ["just now"])
  }

  func testDuplicateAlertIdsStayUnique() {
    let s = snapshot(issues: [issue(0, event: "e1", entity: "pdu_a", name: "PDU A", text: "fault", minutesAgo: 5),
                              issue(0, event: "e2", entity: "crac_2", name: "CRAC 2", text: "alarm", minutesAgo: 9)])
    let ids = build(s).needsYou.map(\.id)
    XCTAssertEqual(Set(ids).count, 2, "\(ids)")
  }

  func testEmptyHandoffPrefixIsNotANote() {
    let s = snapshot(events: [event("e1", device: "gary-phone", minutesAgo: 5, note: "Handoff:  ")])
    XCTAssertTrue(build(s).leftForYou.isEmpty)
  }

  func testChangeIdsDoNotCollide() {
    let s = snapshot(events: [event("e1", device: "gary-phone", minutesAgo: 5)],
                     changes: [FloorChange(eventId: "e1", entityId: "pdu_a", attr: "PSU2", from: "OK", to: "FAULT"),
                               FloorChange(eventId: "e1", entityId: "pdu_a", attr: "fan", from: "OK", to: "LOUD")])
    XCTAssertEqual(Set(build(s).changed.map(\.id)).count, 2)
  }
}
