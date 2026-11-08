//
// BriefingCheck.swift
// Shift Memory
//
// The automated briefing: the script is written from the briefing's facts (Nemotron when a key is
// set, the template otherwise), read aloud, and ended with "Does that make sense?". The app listens
// for a yes. A yes acknowledges the briefing by itself and leaves an ack note for the shift's first
// photo. Anything else (silence, a no, a mumble) gets a short pause and a re-prompt, again and again,
// until the wearer says yes or checks the items off on the screen. Pure parts live in
// `BriefingSynthesis`; this is the sequencing.
//

import Foundation
import Observation

@MainActor
@Observable
final class BriefingCheck {
  enum Phase: Equatable {
    case idle
    case writing                 // asking Nemotron for the script
    case speaking                // reading the briefing
    case listening               // waiting for the yes
    case waiting                 // the pause before a re-prompt
    case reprompting
    case passed
    case unavailable(String)     // mic / speech recognition off

    var isActive: Bool {
      switch self {
      case .idle, .passed, .unavailable: false
      default: true
      }
    }
  }

  /// How long one listen lasts before it counts as silence.
  static let listenTimeout: Duration = .seconds(12)
  /// The quiet gap before asking again.
  static let pauseBeforeReprompt: Duration = .seconds(3)
  /// After this many unanswered prompts the voice stops nagging; the sheet stays for a manual check-off.
  static let maxPrompts = 6

  private(set) var phase: Phase = .idle
  private(set) var spoken: SpokenBriefing?
  private(set) var prompts = 0
  private(set) var heard = ""
  private(set) var lastAnswer: BriefingSynthesis.Answer = .unclear
  /// The "Briefing ack:" note produced by a pass, for the shift's first photo.
  private(set) var ackNote: String?
  var liveTranscript: String { narrator.liveTranscript }

  /// Called once on a pass, with the ack note.
  var onPassed: ((String) -> Void)?

  @ObservationIgnored private let nvidia: NvidiaClient
  @ObservationIgnored private let speaker: BriefingSpeaker
  @ObservationIgnored private let narrator: VoiceNarrator
  @ObservationIgnored private let log: (String) -> Void
  @ObservationIgnored private var task: Task<Void, Never>?
  @ObservationIgnored private var generation = 0

  init(nvidia: NvidiaClient, speaker: BriefingSpeaker, narrator: VoiceNarrator, log: @escaping (String) -> Void) {
    self.nvidia = nvidia
    self.speaker = speaker
    self.narrator = narrator
    self.log = log
  }

  /// Run the whole check for `briefing`. Cancels one in progress.
  func run(_ briefing: Briefing, wearer: String) {
    cancel()
    generation += 1
    let gen = generation
    prompts = 0
    heard = ""
    lastAnswer = .unclear
    ackNote = nil
    task = Task { [weak self] in
      guard let self else { return }
      await self.perform(briefing, wearer: wearer, generation: gen)
    }
  }

  /// Ask again now (the wearer tapped Listen again after the voice gave up).
  func listenAgain(briefing: Briefing, wearer: String) {
    guard !phase.isActive else { return }
    generation += 1
    let gen = generation
    task = Task { [weak self] in
      guard let self else { return }
      await self.speaker.speakAndWait(BriefingSynthesis.askLine)
      guard gen == self.generation else { return }
      await self.confirmLoop(briefing, wearer: wearer, generation: gen)
    }
  }

  func cancel() {
    generation += 1
    task?.cancel()
    task = nil
    speaker.stop()
    narrator.cancel()
    if phase.isActive { phase = .idle }
  }

  // MARK: - Sequence

  private func perform(_ briefing: Briefing, wearer: String, generation gen: Int) async {
    guard await narrator.requestAuthorization() else {
      phase = .unavailable("Microphone or speech recognition is off, so the briefing can't hear you. Check the items off instead.")
      return
    }
    guard gen == generation else { return }

    phase = .writing
    let spoken = await write(briefing, wearer: wearer)
    guard gen == generation else { return }
    self.spoken = spoken
    log("script (\(spoken.source.rawValue), \(BriefingBuilder.wordCount(spoken.script)) words): \(spoken.script)")

    phase = .speaking
    await speaker.speakAndWait(spoken.script)
    guard gen == generation else { return }
    await confirmLoop(briefing, wearer: wearer, generation: gen)
  }

  /// Listen → yes? pass : pause, re-prompt, listen … up to `maxPrompts`.
  private func confirmLoop(_ briefing: Briefing, wearer: String, generation gen: Int) async {
    while prompts < Self.maxPrompts {
      prompts += 1
      phase = .listening
      let said = await listen()
      guard gen == generation else { return }
      let text = said?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if !text.isEmpty { heard = text }
      let answer = BriefingSynthesis.answer(text.isEmpty ? nil : text)
      lastAnswer = answer
      log("prompt \(prompts) heard: \(text.isEmpty ? "(silence)" : text) → \(answer)")

      if answer == .yes {
        let note = BriefingSynthesis.ackNote(wearer: wearer, heard: text, prompts: prompts,
                                             openItems: briefing.needsYou.count, at: Date())
        ackNote = note
        phase = .passed
        await speaker.speakAndWait(BriefingSynthesis.passScript(wearer: wearer))
        guard gen == generation else { return }
        onPassed?(note)
        return
      }

      phase = .waiting
      try? await Task.sleep(for: Self.pauseBeforeReprompt)
      guard gen == generation, !Task.isCancelled else { return }
      if prompts < Self.maxPrompts {
        phase = .reprompting
        await speaker.speakAndWait(BriefingSynthesis.repromptScript(round: prompts, answer: answer))
        guard gen == generation else { return }
      }
    }
    log("gave up after \(prompts) prompts; sheet left for a manual check-off")
    phase = .idle
  }

  // MARK: - Pieces

  private func write(_ briefing: Briefing, wearer: String) async -> SpokenBriefing {
    guard nvidia.hasKey else { return BriefingSynthesis.template(briefing) }
    let sheet = BriefingSynthesis.factSheet(briefing, wearer: wearer)
    do {
      let reply = try await nvidia.complete(system: BriefingSynthesis.scriptSystemPrompt,
                                            user: BriefingSynthesis.scriptUserPrompt(factSheet: sheet))
      if let spoken = BriefingSynthesis.parseScript(reply) { return spoken }
      log("Nemotron script reply not parseable: \(reply.prefix(200))")
    } catch {
      log("Nemotron script failed: \(error)")
    }
    return BriefingSynthesis.template(briefing)
  }

  /// One listen: the narrator's mic + on-device recognition, ended by silence or the timeout.
  private func listen() async -> String? {
    let wasEnabled = narrator.isEnabled
    narrator.isEnabled = true
    narrator.begin()
    defer { narrator.isEnabled = wasEnabled }
    if case .unavailable(let why) = narrator.state {
      log("listen unavailable: \(why)")
      return nil
    }
    return await narrator.takeNarration(timeout: Self.listenTimeout)
  }
}
