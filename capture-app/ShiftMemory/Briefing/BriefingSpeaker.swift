//
// BriefingSpeaker.swift
// Shift Memory
//
// Reads the briefing aloud with the best installed en-US voice (premium, then enhanced, then
// default), a little slower than the default rate so it is easy to follow on a noisy floor. It does
// not touch AVAudioSession categories: the integrator owns audio routing (glasses vs. phone speaker)
// and passes `prepareAudio`, which is called right before each utterance.
//

import AVFAudio
import Observation

@MainActor
@Observable
final class BriefingSpeaker {
  private(set) var isSpeaking = false

  @ObservationIgnored private let synthesizer = AVSpeechSynthesizer()
  @ObservationIgnored private let prepareAudio: () -> Void
  @ObservationIgnored private var relay: Relay?
  @ObservationIgnored private var voice: AVSpeechSynthesisVoice?
  @ObservationIgnored private var voiceResolved = false
  /// The utterance we are speaking now. Delegate callbacks for older (cancelled) utterances arrive
  /// asynchronously after a restart and must not flip `isSpeaking` off for the new one.
  @ObservationIgnored private var current: ObjectIdentifier?

  init(prepareAudio: @escaping () -> Void = {}) {
    self.prepareAudio = prepareAudio
    let relay = Relay { [weak self] utterance in
      Task { @MainActor in self?.utteranceEnded(utterance) }
    }
    self.relay = relay
    synthesizer.delegate = relay
  }

  func speak(_ text: String) {
    let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    if synthesizer.isSpeaking || synthesizer.isPaused { synthesizer.stopSpeaking(at: .immediate) }
    prepareAudio()
    if !voiceResolved { voice = Self.bestVoice(); voiceResolved = true }
    let utterance = AVSpeechUtterance(string: text)
    utterance.voice = voice
    utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
    utterance.postUtteranceDelay = 0.1
    current = ObjectIdentifier(utterance)
    isSpeaking = true
    synthesizer.speak(utterance)
  }

  func stop() {
    current = nil
    synthesizer.stopSpeaking(at: .immediate)
    isSpeaking = false
  }

  private func utteranceEnded(_ utterance: ObjectIdentifier) {
    guard utterance == current else { return }
    current = nil
    isSpeaking = false
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
}
