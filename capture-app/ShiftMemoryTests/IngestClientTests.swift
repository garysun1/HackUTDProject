import XCTest
@testable import ShiftMemory

final class IngestClientTests: XCTestCase {
  func testPositionalProcedureReplyIsMappedOntoFieldNames() {
    let body = Data(#"["2026-11-07T23:27:32.279Z","1794094052279619"]"#.utf8)
    let object = IngestClient.jsonObject(body, positional: ["serverT", "tMicros"])
    XCTAssertEqual(object?["serverT"] as? String, "2026-11-07T23:27:32.279Z")
    XCTAssertEqual(object?["tMicros"] as? String, "1794094052279619")
  }

  func testObjectProcedureReplyIsReturnedAsIs() {
    let body = Data(#"{"eventId":"e1","serverT":"2026-11-07T23:27:32Z","status":"accepted"}"#.utf8)
    let object = IngestClient.jsonObject(body, positional: ["eventId", "serverT", "status"])
    XCTAssertEqual(object?["status"] as? String, "accepted")
    XCTAssertEqual(object?["eventId"] as? String, "e1")
  }

  func testIngestReplyArrayOrderMatchesModuleIngestResult() {
    let body = Data(#"["e1","2026-11-07T23:27:32Z","in_graph"]"#.utf8)
    let object = IngestClient.jsonObject(body, positional: ["eventId", "serverT", "status"])
    XCTAssertEqual(object?["eventId"] as? String, "e1")
    XCTAssertEqual(object?["status"] as? String, "in_graph")
  }
}
