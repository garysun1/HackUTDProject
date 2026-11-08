//
// VoiceNarratorTests.swift
// Shift Memory
//
// The narration parts that need no microphone: the endpointing decision (silence after speech,
// noisy rooms, nothing said, hard cap), the FIFO pairing of narrations to photos with its timeout,
// and the level mapping. Times are plain seconds; nothing touches AVAudioSession or Speech.
//

import XCTest
@testable import ShiftMemory

final class NarrationEndpointerTests: XCTestCase {
  func testKeepsListeningWhileNothingSaidBeforeTimeout() {
    let e = NarrationEndpointer()
    XCTAssertNil(e.decide(at: 6.9))
  }

  func testNoSpeechEndsAfterSevenSeconds() {
    var e = NarrationEndpointer()
    e.level(0.9, at: 3)   // loud but unrecognized (a cough, a fan) still counts as nothing said
    XCTAssertEqual(e.decide(at: 7), .noSpeech)
  }

  func testSilenceAfterSpeechEndsWhenTextStallsAndRoomIsQuiet() {
    var e = NarrationEndpointer()
    e.level(0.7, at: 1.0)
    e.transcript("PSU two", at: 1.2)
    e.level(0.7, at: 1.5)
    XCTAssertNil(e.decide(at: 3.2))          // 2 s since text, only 1.7 s since loud
    XCTAssertEqual(e.decide(at: 3.4), .silence)
  }

  func testLaggyRecognizerDoesNotCutTheSentence() {
    var e = NarrationEndpointer()
    e.transcript("PSU", at: 1)
    e.transcript("PSU two was", at: 2.5)    // text still arriving although the mic went quiet at 1
    XCTAssertNil(e.decide(at: 4.0))
    XCTAssertEqual(e.decide(at: 4.4), .silence)
  }

  func testNoisyRoomEndsOnStalledText() {
    var e = NarrationEndpointer()
    e.transcript("reseated it", at: 1)
    for t in stride(from: 1.0, through: 6.0, by: 0.1) { e.level(0.5, at: t) }  // fans never stop
    XCTAssertNil(e.decide(at: 4.5))
    XCTAssertEqual(e.decide(at: 4.7), .silence)
  }

  func testUnchangedTranscriptIsNotActivity() {
    var e = NarrationEndpointer()
    e.transcript("green now", at: 1)
    e.transcript("green now", at: 2.5)
    XCTAssertEqual(e.lastTextChangeAt, 1)
    XCTAssertEqual(e.decide(at: 2.9), .silence)
  }

  func testHardCapWinsEvenMidSentence() {
    var e = NarrationEndpointer()
    e.transcript("still talking", at: 29.9)
    e.level(0.9, at: 29.9)
    XCTAssertEqual(e.decide(at: 30), .hardCap)
  }

  func testWordCount() {
    XCTAssertEqual(NarrationEndpointer.wordCount("  this PDU\nwas faulting "), 4)
    XCTAssertEqual(NarrationEndpointer.wordCount(""), 0)
  }
}

@MainActor
final class NarrationQueueTests: XCTestCase {
  func testTakeWithNothingQueuedReturnsNilImmediately() async {
    let q = NarrationQueue()
    let start = ContinuousClock.now
    let text = await q.take(timeout: .seconds(5))
    XCTAssertNil(text)
    XCTAssertLessThan(ContinuousClock.now - start, .seconds(1))
  }

  func testFinishedNarrationIsReturnedTrimmed() async {
    let q = NarrationQueue()
    let id = q.open()
    q.resolve(id, "  reseated PSU2, green now \n")
    let text = await q.take(timeout: .seconds(1))
    XCTAssertEqual(text, "reseated PSU2, green now")
    XCTAssertEqual(q.unconsumedCount, 0)
  }

  func testEmptyOrDiscardedNarrationIsNil() async {
    let q = NarrationQueue()
    q.resolve(q.open(), "   ")
    q.resolve(q.open(), nil)
    let first = await q.take(timeout: .seconds(1))
    let second = await q.take(timeout: .seconds(1))
    XCTAssertNil(first)
    XCTAssertNil(second)
  }

  func testTakeIsFIFOEvenWhenLaterOnesFinishFirst() async {
    let q = NarrationQueue()
    let a = q.open()
    let b = q.open()
    q.resolve(b, "second")
    let first = Task { await q.take(timeout: .seconds(5)) }
    try? await Task.sleep(for: .milliseconds(20))   // the first photo takes `a` before the second asks
    let second = Task { await q.take(timeout: .seconds(5)) }
    try? await Task.sleep(for: .milliseconds(20))
    q.resolve(a, "first")
    let firstText = await first.value
    let secondText = await second.value
    XCTAssertEqual(firstText, "first")
    XCTAssertEqual(secondText, "second")
  }

  func testTakeWaitsForAnInFlightNarration() async {
    let q = NarrationQueue()
    let id = q.open()
    let waiter = Task { await q.take(timeout: .seconds(5)) }
    try? await Task.sleep(for: .milliseconds(50))
    q.updatePartial(id, "this PDU")
    q.resolve(id, "this PDU was faulting")
    let text = await waiter.value
    XCTAssertEqual(text, "this PDU was faulting")
  }

  func testTimeoutReturnsPartialTextSoFar() async {
    let q = NarrationQueue()
    let id = q.open()
    q.updatePartial(id, " PSU2 was unseated ")
    let text = await q.take(timeout: .milliseconds(50))
    XCTAssertEqual(text, "PSU2 was unseated")
    q.resolve(id, "PSU2 was unseated, I reseated it")   // late final is harmless
  }

  func testTimeoutWithNoWordsIsNil() async {
    let q = NarrationQueue()
    _ = q.open()
    let text = await q.take(timeout: .milliseconds(50))
    XCTAssertNil(text)
  }

  func testEmptySlotKeepsLaterPhotosPairedWithTheirNarrations() async {
    // Capture 1 starts narration A; capture 2 happens while A is still listening (empty slot);
    // capture 3 starts narration C. Photos arrive in capture order.
    let q = NarrationQueue()
    let a = q.open()
    q.openResolvedEmpty()
    let c = q.open()
    q.resolve(a, "narration for photo one")
    q.resolve(c, "narration for photo three")
    let first = await q.take(timeout: .seconds(1))
    let second = await q.take(timeout: .seconds(1))
    let third = await q.take(timeout: .seconds(1))
    XCTAssertEqual(first, "narration for photo one")
    XCTAssertNil(second)
    XCTAssertEqual(third, "narration for photo three")
  }

  func testCancellingTheWaiterReturnsPartialPromptly() async {
    let q = NarrationQueue()
    let id = q.open()
    q.updatePartial(id, "PSU2")
    let start = ContinuousClock.now
    let waiter = Task { await q.take(timeout: .seconds(30)) }
    try? await Task.sleep(for: .milliseconds(50))
    waiter.cancel()
    let text = await waiter.value
    XCTAssertEqual(text, "PSU2")
    XCTAssertLessThan(ContinuousClock.now - start, .seconds(5))
    XCTAssertTrue(q.hasInFlight)            // the narration itself keeps going
    q.resolve(id, "PSU2 reseated")
    XCTAssertFalse(q.hasInFlight)
  }

  func testResolveBeforeTimeoutWinsAndLateTimeoutIsHarmless() async {
    let q = NarrationQueue()
    let id = q.open()
    let waiter = Task { await q.take(timeout: .milliseconds(150)) }
    try? await Task.sleep(for: .milliseconds(20))
    q.resolve(id, "green now")
    let text = await waiter.value
    XCTAssertEqual(text, "green now")
    try? await Task.sleep(for: .milliseconds(200))   // the cancelled timer must not resume twice
  }

  func testOldestUnconsumedAreDroppedBeyondCap() async {
    let q = NarrationQueue(maxUnconsumed: 2)
    q.resolve(q.open(), "one")
    q.resolve(q.open(), "two")
    q.resolve(q.open(), "three")
    XCTAssertEqual(q.unconsumedCount, 2)
    let first = await q.take(timeout: .seconds(1))
    XCTAssertEqual(first, "two")
  }
}

final class NarrationLevelTests: XCTestCase {
  func testLevelMapping() {
    XCTAssertEqual(VoiceNarrator.normalizedLevel(rms: 0), 0)
    XCTAssertEqual(VoiceNarrator.normalizedLevel(rms: 1), 1)
    XCTAssertEqual(VoiceNarrator.normalizedLevel(rms: 0.01), 0.4, accuracy: 0.001)   // -40 dBFS
  }

  func testDurationToSeconds() {
    XCTAssertEqual(VoiceNarrator.seconds(.milliseconds(4200)), 4.2, accuracy: 1e-9)
  }
}
