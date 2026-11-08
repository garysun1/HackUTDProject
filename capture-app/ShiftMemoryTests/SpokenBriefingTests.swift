//
// SpokenBriefingTests.swift
// Shift Memory
//
// The spoken briefing's pure parts: the fact sheet carries the issues and the handoff without ids,
// Nemotron's JSON is parsed tolerantly and always ends with the question, the template drops the tap
// line, the yes detector takes many ways of agreeing and refuses a no, the re-prompts fit the answer,
// and the ack note says who, when, and what was said. Plus the two clients' request/reply helpers.
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

  func briefing(needsYou: [BriefingItem] = [], lead: String? = nil) -> Briefing {
    Briefing(headline: "Two issues need you.", leadText: lead, leadGeneratedAt: lead == nil ? nil : now,
             needsYou: needsYou, leftForYou: [], changed: [], quiet: ["UPS 1"],
             spokenScript: "Two issues need you. PDU A fault, at Row 1, R12. Tap Got it when you're ready.",
             sinceDate: now.addingTimeInterval(-8 * 3600), generatedAt: now)
  }

  // MARK: Fact sheet and scripts

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

  func testParseScriptAcceptsFencedJSONAndEndsWithTheQuestion() {
    let reply = "Here you go:\n```json\n{\"script\": \"PDU A is faulting at row one, rack twelve. Gary saw it at six\"}\n```"
    let spoken = BriefingSynthesis.parseScript(reply)
    XCTAssertEqual(spoken?.source, .nemotron)
    XCTAssertEqual(spoken?.script, "PDU A is faulting at row one, rack twelve. Gary saw it at six. Does that make sense?")
    XCTAssertNil(BriefingSynthesis.parseScript(#"{"other": 1}"#))
    XCTAssertNil(BriefingSynthesis.parseScript("I cannot do that."))
  }

  func testParseScriptDoesNotDoubleTheQuestion() {
    let spoken = BriefingSynthesis.parseScript(#"{"script": "Nothing is open. Does that make sense?"}"#)
    XCTAssertEqual(spoken?.script, "Nothing is open. Does that make sense?")
  }

  func testTemplateDropsTapLineAndAsksTheQuestion() {
    let spoken = BriefingSynthesis.template(briefing(needsYou: [item("a1", "PDU A fault light")]))
    XCTAssertEqual(spoken.source, .template)
    XCTAssertEqual(spoken.script, "Two issues need you. PDU A fault, at Row 1, R12. Does that make sense?")
  }

  // MARK: The answer

  func testYesInManyForms() {
    for s in ["yes", "Yeah", "yep that makes sense", "okay", "Got it.", "sounds good", "understood", "copy that",
              "I'm good", "sure thing", "Yes it does", "makes sense to me"] {
      XCTAssertEqual(BriefingSynthesis.answer(s), .yes, s)
    }
  }

  func testNoAndUnclear() {
    for s in ["no", "nope", "not really", "can you repeat that", "what", "yes but I don't get the second one"] {
      XCTAssertEqual(BriefingSynthesis.answer(s), .no, s)
    }
    for s in ["", "   ", "hmm", "the weather is nice", "PDU A"] {
      XCTAssertEqual(BriefingSynthesis.answer(s), .unclear, s)
    }
    XCTAssertEqual(BriefingSynthesis.answer(nil), .unclear)
  }

  func testRepromptsFitTheAnswerAndRound() {
    XCTAssertTrue(BriefingSynthesis.repromptScript(round: 1, answer: .no).hasPrefix("No problem."))
    XCTAssertEqual(BriefingSynthesis.repromptScript(round: 1, answer: .unclear), "Still there? Say yes when that makes sense.")
    XCTAssertEqual(BriefingSynthesis.repromptScript(round: 2, answer: .unclear), "Does that make sense? Just say yes.")
    XCTAssertTrue(BriefingSynthesis.repromptScript(round: 5, answer: .unclear).contains("check it off"))
  }

  func testPassScriptUsesTheName() {
    XCTAssertEqual(BriefingSynthesis.passScript(wearer: "Edward"), "Good, Edward. You're up to speed. Starting your shift.")
    XCTAssertEqual(BriefingSynthesis.passScript(wearer: "you"), "Good. You're up to speed. Starting your shift.")
  }

  func testAckNoteSaysWhoWhenAndWhatWasSaid() {
    let one = BriefingSynthesis.ackNote(wearer: "Edward", heard: "yep makes sense", prompts: 1, openItems: 2, at: now, timeZone: utc)
    XCTAssertTrue(one.hasPrefix("Briefing ack: Edward heard the shift briefing (2 open issues) and confirmed it at "))
    XCTAssertTrue(one.hasSuffix(". Said: “yep makes sense”"))
    XCTAssertFalse(one.contains("prompts"))
    let three = BriefingSynthesis.ackNote(wearer: "", heard: "", prompts: 3, openItems: 0, at: now, timeZone: utc)
    XCTAssertTrue(three.hasPrefix("Briefing ack: Wearer heard the shift briefing (nothing open) and confirmed it at "))
    XCTAssertTrue(three.hasSuffix(" after 3 prompts."))
  }

  // MARK: Clients

  func testNvidiaContentTextStripsThinkingBlock() {
    let body = Data(#"{"choices":[{"message":{"role":"assistant","content":"<think>hmm</think>\n{\"script\":\"x\"}"}}]}"#.utf8)
    XCTAssertEqual(NvidiaClient.contentText(from: body), #"{"script":"x"}"#)
    XCTAssertNil(NvidiaClient.contentText(from: Data("{}".utf8)))
  }

  func testNvidiaMultipartBodyAndWavSniff() {
    let body = NvidiaClient.multipartBody(fields: [("text", "hi"), ("language", "en-US")], boundary: "B")
    let s = String(decoding: body, as: UTF8.self)
    XCTAssertTrue(s.hasPrefix("--B\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\nhi\r\n"))
    XCTAssertTrue(s.hasSuffix("--B--\r\n"))
    var wav = Data("RIFF".utf8) + Data(repeating: 0, count: 4) + Data("WAVE".utf8) + Data(repeating: 0, count: 40)
    XCTAssertTrue(NvidiaClient.looksLikeWav(wav))
    wav[0] = 0x7B
    XCTAssertFalse(NvidiaClient.looksLikeWav(wav))
  }

  func testElevenLabsRequestBodyAndMP3Sniff() throws {
    let body = try XCTUnwrap(JSONSerialization.jsonObject(with: ElevenLabsClient.requestBody(text: "hi")) as? [String: Any])
    XCTAssertEqual(body["text"] as? String, "hi")
    XCTAssertEqual(body["model_id"] as? String, "eleven_flash_v2_5")
    XCTAssertTrue(ElevenLabsClient.looksLikeMP3(Data("ID3".utf8) + Data(repeating: 0, count: 8)))
    XCTAssertTrue(ElevenLabsClient.looksLikeMP3(Data([0xFF, 0xFB, 0x90, 0x00, 0x00])))
    XCTAssertFalse(ElevenLabsClient.looksLikeMP3(Data(#"{"detail":"Unauthorized"}"#.utf8)))
  }
}
