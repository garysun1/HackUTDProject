//
// BriefingSpeaker.swift
// Shift Memory
//
// Reads briefing text aloud. With a cloud voice wired in (`synthesize`, Magpie TTS through
// `NvidiaClient`) it plays the returned WAV; without one, or when that fails, it falls back to the
// best installed en-US system voice (premium, then enhanced, then default), a little slower than the
// default rate so it is easy to follow on a noisy floor. `speak` is fire-and-forget for the Read-it
// button; `speakAndWait` is for the automated check, which needs to know when the line has ended.
// It does not touch AVAudioSession categories: the integrator owns audio routing and passes
// `prepareAudio`, which is called right before each utterance.
//

import AVFAudio
import Observation

@MainActor
@Observable
final class BriefingSpeaker {
  private(set) var isSpeaking = false
  /// Which voice spoke last: "Magpie" or the system voice's name. For Settings / diagnostics.
  private(set) var lastVoice = ""

  /// Cloud text-to-speech: text → WAV data. nil = system voice only.
  @ObservationIgnored var synthesize: (@Sendable (String) async throws -> Data)?
  @ObservationIgnored var log: (String) -> Void = { _ in }

  @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
  @ObservationIgnored private let prepareAudio: () -> Void
  @ObservationIgnored private var relay: Relay?
  @ObservationIgnored private var voice: AVSpeechSynthesisVoice?
  @ObservationIgnored private var voiceResolved = false
  @ObservationIgnored private var player: AVAudioPlayer?
  @ObservationIgnored private var playerRelay: PlayerRelay?
  /// Rendered speech by text, so "Read it to me" after the automated pass does not pay for TTS twice.
  @ObservationIgnored private var cache: [String: Data] = [:]
  /// The utterance we are speaking now. Delegate callbacks for older (cancelled) utterances arrive
  /// asynchronously after a restart and must not flip `isSpeaking` off for the new one.
  @ObservationIgnored private var current: ObjectIdentifier?
  @ObservationIgnored private var generation = 0
  @ObservationIgnored private var waiter: CheckedContinuation<Void, Never>?

  init(prepareAudio: @escaping () -> Void = {}) {
    self.prepareAudio = prepareAudio
    let relay = Relay { [weak self] utterance in
      Task { @MainActor in self?.utteranceEnded(utterance) }
    }
    self.relay = relay
    synthesizer.delegate = relay
  }

  func speak(_ text: String) {
    Task { await speakAndWait(text) }
  }

  /// Speaks `text` and returns when it has finished (or was stopped / replaced).
  func speakAndWait(_ text: String) async {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    stop()
    generation += 1
    let gen = generation
    isSpeaking = true

    if let synthesize {
      var data = cache[text]
      if data == nil {
        do {
          data = try await synthesize(text)
          if let data { cache[text] = data; if cache.count > 12 { cache.removeValue(forKey: cache.keys.first!) } }
        } catch {
          log("cloud voice failed, using the system voice: \(error)")
        }
      }
      guard gen == generation else { return }
      if let data, await play(data, generation: gen) { return }
      guard gen == generation else { return }
    }
    await speakWithSystemVoice(text, generation: gen)
  }

  func stop() {
    generation += 1
    current = nil
    if synthesizer.isSpeaking || synthesizer.isPaused { synthesizer.stopSpeaking(at: .immediate) }
    player?.stop()
    player = nil
    isSpeaking = false
    resumeWaiter()
  }

  // MARK: Cloud playback

  /// true when the WAV played to the end (or was stopped); false when it could not be played at all.
  private func play(_ data: Data, generation gen: Int) async -> Bool {
    prepareAudio()
    let player: AVAudioPlayer
    do {
      player = try AVAudioPlayer(data: data)
    } catch {
      log("could not decode cloud speech: \(error)")
      return false
    }
    let relay = PlayerRelay { [weak self] in Task { @MainActor in self?.playerEnded(generation: gen) } }
    playerRelay = relay
    player.delegate = relay
    player.prepareToPlay()
    guard player.play() else { log("cloud speech did not start"); return false }
    self.player = player
    lastVoice = "Magpie"
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in waiter = c }
    return true
  }

  private func playerEnded(generation gen: Int) {
    guard gen == generation else { return }
    player = nil
    isSpeaking = false
    resumeWaiter()
  }

  // MARK: System voice

  private func speakWithSystemVoice(_ text: String, generation gen: Int) async {
    prepareAudio()
    if !voiceResolved { voice = Self.bestVoice(); voiceResolved = true }
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
    utterance.postUtteranceDelay = 0.1
    current = ObjectIdentifier(utterance)
    lastVoice = voice?.name ?? "System"
    isSpeaking = true
    synthesizer.speak(utterance)
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in waiter = c }
  }

  private func utteranceEnded(_ utterance: ObjectIdentifier) {
    guard utterance == current else { return }
    current = nil
    isSpeaking = false
    resumeWaiter()
  }

  private func resumeWaiter() {
    let w = waiter
    waiter = nil
    w?.resume()
  }

  /// Premium, then enhanced, then the system default among installed en-US voices, skipping novelty
  /// and personal voices; nil = let the system pick.
  static func bestVoice() -> AVSpeechSynthesisVoice? {
    let english = AVSpeechSynthesisVoice.speechVoices().filter {
      $0.language == "en-US"
        && !$0.voiceTraits.contains(.isNoveltyVoice) && !$0.voiceTraits.contains(.isPersonalVoice)
    }
    if let premium = english.first(where: { $0.quality == .premium }) { return premium }
    if let enhanced = english.first(where: { $0.quality == .enhanced }) { return enhanced }
    return AVSpeechSynthesisVoice(language: "en-US")
  }

  /// The delegate is an Objective-C protocol called off our isolation; it only forwards which
  /// utterance ended (as a Sendable identity), and the main actor decides whether it is current.
  private final class Relay: NSObject, AVSpeechSynthesizerDelegate, Sendable {
    let onEnd: @Sendable (ObjectIdentifier) -> Void
    init(onEnd: @escaping @Sendable (ObjectIdentifier) -> Void) { self.onEnd = onEnd }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
      onEnd(ObjectIdentifier(utterance))
    }
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
      onEnd(ObjectIdentifier(utterance))
    }
  }

  private final class PlayerRelay: NSObject, AVAudioPlayerDelegate, Sendable {
    let onEnd: @Sendable () -> Void
    init(onEnd: @escaping @Sendable () -> Void) { self.onEnd = onEnd }
    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) { onEnd() }
    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) { onEnd() }
  }
}
