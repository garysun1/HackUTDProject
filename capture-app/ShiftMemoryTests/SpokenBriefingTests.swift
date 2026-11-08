//
// SpokenBriefingTests.swift
// Shift Memory
//
// The spoken briefing's pure parts: the fact sheet carries the issues and the handoff without ids,
// Nemotron's JSON is parsed tolerantly (fences, prose, strings for indexes), facts the grader left
// out count as missed, the template fallback asks the question and names the open issues, the
// keyword grade is forgiving on wording and strict on substance, and the ack note says who, when,
// what was repeated, and what was not.
//

import XCTest
@testable import ShiftMemory

final class SpokenBriefingTests: XCTestCase {
  let now = Date(timeIntervalSince1970: 1_794_100_000)
  let utc = TimeZone(identifier: "UTC")!

  func item(_ id: String, _ title: String, place: String? = "Row 1 · Rack R12", who: String? = "Gary",
            severity: BriefingItem.Severity = .critical) -> BriefingItem {
    BriefingItem(id: id, title: title, detail: title, place: place, who: who, when: now.addingTimeInterval(-1800),
                 eventId: "e-\(id)", issueId: 7, severity: severity)
  }

  func briefing(needsYou: [BriefingItem] = [], lead: String? = nil, leftForYou: [BriefingItem] = []) -> Briefing {
    Briefing(headline: "Two issues need you.", leadText: lead, leadGeneratedAt: lead == nil ? nil : now,
             needsYou: needsYou, leftForYou: leftForYou, changed: [], quiet: ["UPS 1"],
             spokenScript: "Two issues need you. PDU A fault, at Row 1, R12. Tap Got it when you're ready.",
             sinceDate: now.addingTimeInterval(-8 * 3600), generatedAt: now)
  }

  // MARK: Fact sheet

  func testFactSheetListsIssuesPlacesHandoffAndQuietWithoutIds() {
    let b = briefing(needsYou: [item("a1", "PDU A fault light"), item("a2", "CRAC 2 alarm", place: "Row 1 end", severity: .warning)],
                     lead: "Reseat PSU 2 on R12 if it faults again.")
    let sheet = BriefingSynthesis.factSheet(b, wearer: "Edward", timeZone: utc)
    XCTAssertTrue(sheet.contains("Wearer starting now: Edward."))
    XCTAssertTrue(sheet.contains("Handoff from the previous shift: Reseat PSU 2"))
    XCTAssertTrue(sheet.contains("1. [critical] PDU A fault light (at Row 1, Rack R12), seen by Gary at"))
    XCTAssertTrue(sheet.contains("2. [warning] CRAC 2 alarm (at Row 1 end)"))
    XCTAssertTrue(sheet.contains("Not looked at in the window: UPS 1."))
    XCTAssertFalse(sheet.contains("e-a1"), "event ids never reach the model")
  }

  // MARK: Parsing

  func testParseScriptAcceptsFencedJSONAndAppendsTheQuestion() {
    let reply = """
    Here you go:
    ```json
    {"script": "PDU A is faulting at row one, rack twelve. Gary saw it at six.", "must_know": ["PDU A fault at Row 1 R12", "  ", "Reseat PSU 2 if it faults", "x", "y"]}
    ```
    """
    let spoken = BriefingSynthesis.parseScript(reply)
    XCTAssertEqual(spoken?.source, .nemotron)
    XCTAssertEqual(spoken?.mustKnow, ["PDU A fault at Row 1 R12", "Reseat PSU 2 if it faults", "x"], "blank dropped, capped at three")
    XCTAssertTrue(spoken?.script.hasPrefix("PDU A is faulting") == true)
    XCTAssertTrue(spoken?.script.hasSuffix(BriefingSynthesis.askLine) == true)
  }

  func testParseScriptRejectsMissingScript() {
    XCTAssertNil(BriefingSynthesis.parseScript(#"{"must_know": ["a"]}"#))
    XCTAssertNil(BriefingSynthesis.parseScript("I cannot do that."))
  }

  func testParseGradeTreatsUnlistedFactsAsMissedAndAcceptsStringIndexes() {
    let grade = BriefingSynthesis.parseGrade(#"{"covered": ["0", 2.0], "missed": []}"#, count: 4)
    XCTAssertEqual(grade?.covered, [0, 2])
    XCTAssertEqual(grade?.missed, [1, 3])
    XCTAssertEqual(grade?.passed, false)
    XCTAssertEqual(BriefingSynthesis.parseGrade(#"{"covered":[0,1],"missed":[]}"#, count: 2)?.passed, true)
    XCTAssertNil(BriefingSynthesis.parseGrade("no json here", count: 2))
  }

  func testParseGradeIgnoresOutOfRangeIndexes() {
    let grade = BriefingSynthesis.parseGrade(#"{"covered": [0, 9], "missed": [-1]}"#, count: 1)
    XCTAssertEqual(grade?.covered, [0])
    XCTAssertEqual(grade?.missed, [])
  }

  // MARK: Fallbacks

  func testTemplateDropsTapLineAsksTheQuestionAndNamesIssuesThenHandoff() {
    let b = briefing(needsYou: [item("a1", "PDU A fault light"), item("a2", "CRAC 2 alarm", place: nil)],
                     lead: "Reseat PSU 2 on R12 if it faults again and tell the day lead before you leave.")
    let spoken = BriefingSynthesis.template(b)
    XCTAssertEqual(spoken.source, .template)
    XCTAssertFalse(spoken.script.contains("Tap Got it"))
    XCTAssertTrue(spoken.script.hasSuffix(BriefingSynthesis.askLine))
    XCTAssertEqual(spoken.mustKnow.count, 3)
    XCTAssertEqual(spoken.mustKnow[0], "PDU A fault light at Row 1 Rack R12")
    XCTAssertEqual(spoken.mustKnow[1], "CRAC 2 alarm")
    XCTAssertTrue(spoken.mustKnow[2].hasPrefix("Reseat PSU 2 on R12"))
    XCTAssertTrue(spoken.mustKnow[2].hasSuffix("…"), "handoff clipped to twelve words")
  }

  func testKeywordGradeIsLooseOnWordingAndStrictOnSubstance() {
    let facts = ["PDU A fault at Row 1 Rack R12", "CRAC 2 alarm", "Reseat PSU 2 if it faults"]
    let grade = BriefingSynthesis.keywordGrade(mustKnow: facts, heard: "um the pdu has a fault and i should reseat the psu")
    XCTAssertEqual(grade.covered, [0, 2])
    XCTAssertEqual(grade.missed, [1])
    XCTAssertTrue(BriefingSynthesis.keywordGrade(mustKnow: facts, heard: "pdu fault, crac alarm, reseat psu").passed)
    XCTAssertEqual(BriefingSynthesis.keywordGrade(mustKnow: facts, heard: "").missed, [0, 1, 2])
  }

  func testKeywordGradeSkipsFactsWithNoDistinctiveWords() {
    XCTAssertTrue(BriefingSynthesis.keywordGrade(mustKnow: ["Check it."], heard: "okay").passed)
  }

  // MARK: Follow-ups and the note

  func testReaskAndFailScriptsNameTheMissedFacts() {
    XCTAssertEqual(BriefingSynthesis.reaskScript(missed: ["CRAC 2 alarm"], round: 1),
                   "Almost. One more time on these. CRAC 2 alarm. Say those back to me.")
    XCTAssertTrue(BriefingSynthesis.reaskScript(missed: ["a", "b"], round: 2).hasPrefix("Last pass"))
    XCTAssertTrue(BriefingSynthesis.failScript(missed: ["CRAC 2 alarm"]).contains("CRAC 2 alarm."))
  }

  func testAckNoteSaysWhoWhenWhatWasRepeatedAndWhatWasNot() {
    let facts = ["PDU A fault at Row 1 R12", "CRAC 2 alarm"]
    let pass = BriefingSynthesis.ackNote(wearer: "Edward", grade: AckGrade(covered: [0, 1], missed: []), mustKnow: facts,
                                         heard: "pdu fault, crac alarm", rounds: 1, at: now, timeZone: utc)
    XCTAssertTrue(pass.hasPrefix("Briefing ack: Edward confirmed the briefing at "))
    XCTAssertTrue(pass.contains("Repeated back: PDU A fault at Row 1 R12. CRAC 2 alarm."))
    XCTAssertFalse(pass.contains("Not repeated"))
    XCTAssertTrue(pass.contains("Said: “pdu fault, crac alarm”"))

    let partial = BriefingSynthesis.ackNote(wearer: "", grade: AckGrade(covered: [0], missed: [1]), mustKnow: facts,
                                            heard: "pdu fault", rounds: 3, at: now, timeZone: utc)
    XCTAssertTrue(partial.hasPrefix("Briefing ack: Wearer partly confirmed the briefing at "))
    XCTAssertTrue(partial.contains("after 3 passes."))
    XCTAssertTrue(partial.contains("Not repeated: CRAC 2 alarm."))
  }

  // MARK: NvidiaClient parsing

  func testContentTextStripsThinkingBlock() {
    let body = Data(#"{"choices":[{"message":{"role":"assistant","content":"<think>hmm</think>\n{\"script\":\"x\"}"}}]}"#.utf8)
    XCTAssertEqual(NvidiaClient.contentText(from: body), #"{"script":"x"}"#)
    XCTAssertNil(NvidiaClient.contentText(from: Data("{}".utf8)))
  }

  func testMultipartBodyAndWavSniff() {
    let body = NvidiaClient.multipartBody(fields: [("text", "hi"), ("language", "en-US")], boundary: "B")
    let s = String(decoding: body, as: UTF8.self)
    XCTAssertTrue(s.hasPrefix("--B\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\nhi\r\n"))
    XCTAssertTrue(s.hasSuffix("--B--\r\n"))
    var wav = Data("RIFF".utf8) + Data(repeating: 0, count: 4) + Data("WAVE".utf8) + Data(repeating: 0, count: 40)
    XCTAssertTrue(NvidiaClient.looksLikeWav(wav))
    wav[0] = 0x7B
    XCTAssertFalse(NvidiaClient.looksLikeWav(wav))
    XCTAssertFalse(NvidiaClient.looksLikeWav(Data(#"{"detail":"Unauthorized"}"#.utf8)))
  }
}
