//
// VoiceNarrator.swift
// Shift Memory
//
// Spoken context after a capture. The wearer presses the shutter, the chime plays, and while the
// photo crawls over from the glasses (10–45 s) they say what happened ("PSU2 was unseated, I
// reseated it, it's green now"). Speech is transcribed on the phone with SFSpeechRecognizer
// (on-device when the locale supports it); no audio is stored or uploaded. The transcript becomes
// the event's note, which the backend's perception step reads.
//
// Three pieces:
//   NarrationEndpointer  pure decision of when a narration is over (silence after speech, nothing
//                        said at all, hard cap). Uses both signals, recognizer text and mic level,
//                        so a loud room (fans) still ends on stalled text and a laggy recognizer
//                        does not cut a sentence short.
//   NarrationQueue       FIFO of narrations; each `begin()` opens one, each photo takes the oldest
//                        unconsumed one. Testable without a microphone.
//   VoiceNarrator        the AVAudioEngine tap + recognition task, state for the UI, logging.
//
// Background: works with the phone locked as long as the audio session can be activated (the app
// has the `audio` background mode). If it cannot, the narration resolves to nil immediately so the
// photo is never held waiting for words that will not come.
//

import AVFoundation
import Foundation
import Observation
import Speech

// MARK: - Endpointing

/// When to stop listening. Times are seconds since the narration started.
struct NarrationEndpointer: Equatable {
  struct Config: Equatable {
    /// Silence (no new words and a quiet mic) after at least one word.
    var silenceAfterSpeech: TimeInterval = 1.8
    /// No new words for this long ends it even if the room never goes quiet (fans, alarms).
    var stalledTextLimit: TimeInterval = 3.6
    /// Nothing recognized at all.
    var noSpeechTimeout: TimeInterval = 7
    /// Hard cap, well inside SFSpeech's one-minute limit.
    var hardCap: TimeInterval = 30
    /// Normalized level (0...1, see `VoiceNarrator.normalizedLevel`) at or above which the mic counts as loud.
    var loudLevel: Float = 0.3
  }

  enum Reason: String, Equatable { case silence, noSpeech, hardCap }

  let config: Config
  private(set) var words = 0
  private(set) var lastTextChangeAt: TimeInterval = 0
  private(set) var lastLoudAt: TimeInterval = 0
  private var lastText = ""

  init(config: Config = Config()) { self.config = config }

  /// The recognizer's latest partial (or final) text. Any change counts as activity.
  mutating func transcript(_ text: String, at t: TimeInterval) {
    guard text != lastText else { return }
    lastText = text
    words = Self.wordCount(text)
    lastTextChangeAt = t
  }

  /// One mic level reading.
  mutating func level(_ level: Float, at t: TimeInterval) {
    if level >= config.loudLevel { lastLoudAt = max(lastLoudAt, t) }
  }

  /// nil to keep listening, otherwise why to stop.
  func decide(at t: TimeInterval) -> Reason? {
    if t >= config.hardCap { return .hardCap }
    if words == 0 { return t >= config.noSpeechTimeout ? .noSpeech : nil }
    let sinceText = t - lastTextChangeAt
    let sinceLoud = t - lastLoudAt
    if sinceText >= config.silenceAfterSpeech && sinceLoud >= config.silenceAfterSpeech { return .silence }
    if sinceText >= config.stalledTextLimit { return .silence }
    return nil
  }

  static func wordCount(_ text: String) -> Int {
    text.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).count
  }
}

// MARK: - FIFO of narrations

/// Narrations in the order they were begun. `take` hands the oldest unconsumed one to the photo
/// that is waiting for it.
@MainActor
final class NarrationQueue {
  typealias ID = Int

  private struct Waiter {
    let continuation: CheckedContinuation<String?, Never>
    let timer: Task<Void, Never>
  }

  private final class Entry {
    let id: ID
    var partial = ""
    var final: String?
    var finished = false
    var waiters: [Int: Waiter] = [:]
    init(id: ID) { self.id = id }
  }

  /// Unconsumed narrations, oldest first; older ones are dropped beyond this.
  let maxUnconsumed: Int
  private var unconsumed: [Entry] = []
  private var inFlight: [ID: Entry] = [:]
  private var nextID: ID = 1
  private var nextWaiter = 1

  init(maxUnconsumed: Int = 8) { self.maxUnconsumed = maxUnconsumed }

  var unconsumedCount: Int { unconsumed.count }
  var hasInFlight: Bool { !inFlight.isEmpty }

  /// Start a narration record. Returns its id.
  func open() -> ID {
    let entry = Entry(id: nextID)
    nextID += 1
    unconsumed.append(entry)
    inFlight[entry.id] = entry
    if unconsumed.count > maxUnconsumed { unconsumed.removeFirst(unconsumed.count - maxUnconsumed) }
    return entry.id
  }

  /// Latest partial text; what a timed-out `take` returns.
  func updatePartial(_ id: ID, _ text: String) {
    inFlight[id]?.partial = text
  }

  /// The narration is over; `text` nil means nothing usable (discarded, failed, no speech).
  func resolve(_ id: ID, _ text: String?) {
    guard let entry = inFlight.removeValue(forKey: id) else { return }
    entry.final = Self.clean(text)
    entry.finished = true
    let waiters = entry.waiters
    entry.waiters = [:]
    for (_, waiter) in waiters {
      waiter.timer.cancel()
      waiter.continuation.resume(returning: entry.final)
    }
  }

  /// Open a record that is already over with no text. Used when a capture happens while another
  /// narration is still listening, so every capture still owns exactly one queue slot and later
  /// photos stay paired with their own narrations.
  func openResolvedEmpty() {
    resolve(open(), nil)
  }

  /// Consume the oldest unconsumed narration and wait for it to finish (or `timeout`, in which case
  /// its partial text so far is returned). nil immediately when nothing is queued. Cancelling the
  /// calling task ends the wait early the same way a timeout does.
  func take(timeout: Duration) async -> String? {
    guard !unconsumed.isEmpty else { return nil }
    let entry = unconsumed.removeFirst()
    if entry.finished { return entry.final }
    let id = entry.id
    let waiter = nextWaiter
    nextWaiter += 1
    return await withTaskCancellationHandler {
      await withCheckedContinuation { continuation in
        let timer = Task { [weak self] in
          try? await Task.sleep(for: timeout)
          guard !Task.isCancelled else { return }
          self?.expire(id, waiter: waiter)
        }
        entry.waiters[waiter] = Waiter(continuation: continuation, timer: timer)
        // Cancelled before the continuation was registered: the handler below found nothing to end.
        if Task.isCancelled { expire(id, waiter: waiter) }
      }
    } onCancel: {
      Task { @MainActor [weak self] in self?.expire(id, waiter: waiter) }
    }
  }

  private func expire(_ id: ID, waiter: Int) {
    guard let entry = inFlight[id], let w = entry.waiters.removeValue(forKey: waiter) else { return }
    w.timer.cancel()
    w.continuation.resume(returning: Self.clean(entry.partial))
  }

  /// Trimmed text, nil when empty.
  nonisolated static func clean(_ text: String?) -> String? {
    guard let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines), !trimmed.isEmpty else { return nil }
    return trimmed
  }
}

// MARK: - Narrator

@MainActor
@Observable
final class VoiceNarrator {
  enum State: Equatable { case idle, listening, finishing, unavailable(String) }

  private(set) var state: State = .idle
  /// Partial text while listening.
  private(set) var liveTranscript = ""
  /// Final text of the last narration.
  private(set) var lastTranscript: String?
  /// When `lastTranscript` was produced (for the banner's "recent note" line).
  private(set) var lastTranscriptAt: Date?
  /// 0...1 input level for a meter.
  private(set) var level: Float = 0
  /// Settings toggle mirror. Turning it off cancels a narration in progress.
  var isEnabled = true {
    didSet {
      guard !isEnabled, oldValue else { return }
      cancel()
      if case .unavailable = state { state = finishing.isEmpty ? .idle : .finishing }
    }
  }

  @ObservationIgnored private let audio: AudioSessionCoordinator
  @ObservationIgnored private let log: (String) -> Void
  @ObservationIgnored private let recognizer: SFSpeechRecognizer?
  @ObservationIgnored let queue = NarrationQueue()
  @ObservationIgnored private var current: Live?
  @ObservationIgnored private var finishing: [NarrationQueue.ID: Live] = [:]
  @ObservationIgnored private var ticker: Task<Void, Never>?
  @ObservationIgnored var endpointConfig = NarrationEndpointer.Config()
  /// How long to wait for the recognizer's final result after the mic stops.
  @ObservationIgnored var finalResultGrace: Duration = .seconds(3)

  /// One narration's live machinery.
  private final class Live {
    let id: NarrationQueue.ID
    let started = ContinuousClock.now
    let request: SFSpeechAudioBufferRecognitionRequest
    let engine: AVAudioEngine
    var task: SFSpeechRecognitionTask?
    var endpointer: NarrationEndpointer
    var text = ""
    var configObserver: NSObjectProtocol?
    var finalGuard: Task<Void, Never>?
    init(id: NarrationQueue.ID, request: SFSpeechAudioBufferRecognitionRequest, engine: AVAudioEngine, config: NarrationEndpointer.Config) {
      self.id = id
      self.request = request
      self.engine = engine
      self.endpointer = NarrationEndpointer(config: config)
    }
    var elapsed: TimeInterval { VoiceNarrator.seconds(ContinuousClock.now - started) }
  }

  init(audio: AudioSessionCoordinator, log: @escaping (String) -> Void) {
    self.audio = audio
    self.log = log
    self.recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")) ?? SFSpeechRecognizer()
  }

  // MARK: Authorization

  /// Speech recognition and microphone permission. Prompts on first use.
  func requestAuthorization() async -> Bool {
    let speech = await Self.requestSpeechAuthorization()
    let mic: Bool
    if AVAudioApplication.shared.recordPermission == .granted {
      mic = true
    } else {
      mic = await AVAudioApplication.requestRecordPermission()
    }
    let ok = speech == .authorized && mic
    log("narration: authorization speech=\(Self.describe(speech)) mic=\(mic ? "granted" : "denied")")
    if !ok {
      state = .unavailable(speech == .authorized ? "Microphone access is off. Turn it on in Settings to add spoken notes."
                                                 : "Speech recognition is off. Turn it on in Settings to add spoken notes.")
    } else if case .unavailable = state {
      state = .idle
    }
    return ok
  }

  @concurrent
  private nonisolated static func requestSpeechAuthorization() async -> SFSpeechRecognizerAuthorizationStatus {
    let status = SFSpeechRecognizer.authorizationStatus()
    guard status == .notDetermined else { return status }
    return await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
  }

  // MARK: Control

  /// Start a narration now. No-op when disabled; keeps (does not restart) one already listening.
  func begin() {
    guard isEnabled else { return }
    if let live = current {
      // One narration covers both captures; it pairs with the earlier photo and this capture gets
      // an empty slot, so the FIFO stays one slot per capture.
      queue.openResolvedEmpty()
      log("narration: already listening #\(live.id), keeping it (this capture gets no note)")
      return
    }
    let id = queue.open()

    guard SFSpeechRecognizer.authorizationStatus() == .authorized,
          AVAudioApplication.shared.recordPermission == .granted else {
      fail(id, "Microphone or speech recognition permission is off.")
      return
    }
    guard let recognizer, recognizer.isAvailable else {
      fail(id, "Speech recognition is unavailable right now.")
      return
    }
    do {
      try audio.activateForRecording()
    } catch {
      fail(id, "Could not start the microphone: \(error.localizedDescription)")
      return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.addsPunctuation = true
    request.taskHint = .dictation
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }

    let engine = AVAudioEngine()
    let input = engine.inputNode
    let format = input.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      audio.deactivate()
      fail(id, "No microphone input is available.")
      return
    }
    input.installTap(onBus: 0, bufferSize: 1024, format: format,
                     block: Self.makeTap(request: request, id: id, owner: self))
    engine.prepare()
    do {
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      audio.deactivate()
      fail(id, "Could not start the microphone: \(error.localizedDescription)")
      return
    }

    let live = Live(id: id, request: request, engine: engine, config: endpointConfig)
    live.task = recognizer.recognitionTask(with: request, resultHandler: Self.makeResultHandler(id: id, owner: self))
    live.configObserver = NotificationCenter.default.addObserver(
      forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
    ) { [weak self] _ in
      MainActor.assumeIsolated { self?.routeChanged(id) }
    }
    current = live
    liveTranscript = ""
    level = 0
    state = .listening
    startTicker()
    log("narration: listening #\(id) (route=\(audio.routeDescription), onDevice=\(request.requiresOnDeviceRecognition))")
  }

  /// The wearer tapped Done: stop listening and keep what was said.
  func stop() {
    guard let live = current else { return }
    log("narration: done tapped #\(live.id)")
    finishListening(live)
  }

  /// Discard the narration in progress; its photo gets no note.
  func cancel() {
    guard let live = current else { return }
    stopInput(live)
    live.task?.cancel()
    queue.resolve(live.id, nil)
    current = nil
    liveTranscript = ""
    level = 0
    log("narration: cancelled #\(live.id)")
    audio.deactivate()
    refreshState()
  }

  /// FIFO: waits for the oldest unconsumed narration to finish (or `timeout`, returning its partial
  /// text so far) and returns its trimmed text. nil immediately when none is queued.
  func takeNarration(timeout: Duration) async -> String? {
    await queue.take(timeout: timeout)
  }

  /// Wire to `AudioSessionCoordinator.onInterruption`: a call or Siri ends the narration, keeping
  /// what was already said.
  func handleInterruption(began: Bool) {
    guard began, let live = current else { return }
    log("narration: interrupted #\(live.id)")
    finishListening(live)
  }

  // MARK: Lifecycle

  private func fail(_ id: NarrationQueue.ID, _ reason: String) {
    queue.resolve(id, nil)
    state = .unavailable(reason)
    log("narration: unavailable #\(id): \(reason)")
  }

  private func startTicker() {
    ticker?.cancel()
    ticker = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(100))
        guard let self, let live = self.current else { return }
        if let reason = live.endpointer.decide(at: live.elapsed) {
          self.log("narration: endpoint #\(live.id) (\(reason.rawValue), \(String(format: "%.1f", live.elapsed)) s)")
          self.finishListening(live)
          return
        }
      }
    }
  }

  /// Mic off, ask the recognizer for its final result, and wait briefly for it.
  private func finishListening(_ live: Live) {
    guard current === live else { return }
    stopInput(live)
    live.request.endAudio()
    current = nil
    level = 0
    finishing[live.id] = live
    let id = live.id
    let grace = finalResultGrace
    live.finalGuard = Task { [weak self] in
      try? await Task.sleep(for: grace)
      guard !Task.isCancelled, let self, let live = self.finishing[id] else { return }
      self.log("narration: no final result #\(id) after \(grace), using partial")
      live.task?.cancel()
      self.complete(live)
    }
    audio.deactivate()
    log("narration: finishing #\(id) (waiting up to \(grace) for the final result)")
    refreshState()
  }

  /// Resolve the narration with the best text we have.
  private func complete(_ live: Live) {
    if current === live {
      stopInput(live)
      live.request.endAudio()
      current = nil
      level = 0
      audio.deactivate()
    }
    finishing[live.id] = nil
    live.finalGuard?.cancel()
    let text = NarrationQueue.clean(live.text)
    queue.resolve(live.id, text)
    if let text {
      lastTranscript = text
      lastTranscriptAt = Date()
      let preview = text.count > 60 ? String(text.prefix(60)) + "…" : text
      log("narration: final #\(live.id) '\(preview)' (\(NarrationEndpointer.wordCount(text)) words, \(String(format: "%.1f", live.elapsed)) s)")
    } else {
      log("narration: final #\(live.id) empty (\(String(format: "%.1f", live.elapsed)) s)")
    }
    refreshState()
  }

  private func stopInput(_ live: Live) {
    if current === live { ticker?.cancel(); ticker = nil }
    if let observer = live.configObserver {
      NotificationCenter.default.removeObserver(observer)
      live.configObserver = nil
    }
    live.engine.inputNode.removeTap(onBus: 0)
    live.engine.stop()
  }

  private func refreshState() {
    if current != nil {
      state = .listening
    } else if !finishing.isEmpty {
      state = .finishing
    } else if case .unavailable = state {
      // keep the reason visible until the next narration starts
    } else {
      state = .idle
      liveTranscript = ""
    }
  }

  private func routeChanged(_ id: NarrationQueue.ID) {
    guard let live = current, live.id == id else { return }
    log("narration: audio route changed #\(id) (\(audio.routeDescription)), finishing")
    finishListening(live)
  }

  // MARK: Callbacks (hopped to the main actor)

  private func ingest(level newLevel: Float, id: NarrationQueue.ID) {
    guard let live = current, live.id == id else { return }
    // Fast attack, slower release, so the meter reads as speech rather than flicker.
    level = newLevel > level ? newLevel : level * 0.8 + newLevel * 0.2
    live.endpointer.level(newLevel, at: live.elapsed)
  }

  private func ingest(text: String?, isFinal: Bool, errorDomain: String?, errorCode: Int?, errorText: String?, id: NarrationQueue.ID) {
    let live: Live
    if let c = current, c.id == id { live = c } else if let f = finishing[id] { live = f } else { return }
    if let text {
      live.text = text
      queue.updatePartial(id, text)
      if current === live {
        liveTranscript = text
        live.endpointer.transcript(text, at: live.elapsed)
      }
    }
    if isFinal {
      complete(live)
      return
    }
    if let errorCode {
      // 1110 is "no speech detected": an empty narration, not a failure.
      if errorCode != 1110 {
        log("narration: recognizer error #\(id) \(errorDomain ?? "?") \(errorCode): \(errorText ?? "")")
      }
      complete(live)
    }
  }

  // Built outside the main actor: the tap runs on the audio render thread and the result handler
  // on a Speech queue, so neither closure may inherit main-actor isolation.

  private final class RequestBox: @unchecked Sendable {
    let request: SFSpeechAudioBufferRecognitionRequest
    init(_ request: SFSpeechAudioBufferRecognitionRequest) { self.request = request }
  }

  private nonisolated static func makeTap(request: SFSpeechAudioBufferRecognitionRequest, id: NarrationQueue.ID,
                                          owner: VoiceNarrator) -> AVAudioNodeTapBlock {
    let box = RequestBox(request)
    return { [weak owner] buffer, _ in
      box.request.append(buffer)
      let value = normalizedLevel(buffer)
      Task { @MainActor in owner?.ingest(level: value, id: id) }
    }
  }

  private nonisolated static func makeResultHandler(id: NarrationQueue.ID, owner: VoiceNarrator)
    -> @Sendable (SFSpeechRecognitionResult?, (any Error)?) -> Void {
    return { [weak owner] result, error in
      let text = result?.bestTranscription.formattedString
      let isFinal = result?.isFinal ?? false
      let ns = error.map { $0 as NSError }
      let domain = ns?.domain, code = ns?.code, message = ns?.localizedDescription
      Task { @MainActor in
        owner?.ingest(text: text, isFinal: isFinal, errorDomain: domain, errorCode: code, errorText: message, id: id)
      }
    }
  }

  // MARK: Pure helpers

  /// RMS of the first channel mapped to 0...1 over -60...-10 dBFS.
  nonisolated static func normalizedLevel(_ buffer: AVAudioPCMBuffer) -> Float {
    guard let channels = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
    let samples = channels[0]
    let n = Int(buffer.frameLength)
    var sum: Float = 0
    for i in 0..<n { sum += samples[i] * samples[i] }
    return normalizedLevel(rms: (sum / Float(n)).squareRoot())
  }

  nonisolated static func normalizedLevel(rms: Float) -> Float {
    let db = 20 * log10(max(rms, 1e-7))
    return min(1, max(0, (db + 60) / 50))
  }

  nonisolated static func seconds(_ d: Duration) -> TimeInterval {
    Double(d.components.seconds) + Double(d.components.attoseconds) / 1e18
  }

  private nonisolated static func describe(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: "authorized"
    case .denied: "denied"
    case .restricted: "restricted"
    case .notDetermined: "notDetermined"
    @unknown default: "unknown"
    }
  }
}
