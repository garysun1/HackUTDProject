//
// BriefingCheck.swift
// Shift Memory
//
// The automated briefing: Nemotron writes the script from the briefing's facts, the speaker reads it
// (Magpie voice), the wearer repeats the key points back, Nemotron grades them; anything missed is
// re-explained and asked again, twice at most. A pass acknowledges the briefing by itself and leaves
// an ack note for the shift's first photo; a fail hands the sheet back to the wearer to check off.
// Without a key or a network the template script and a keyword grade stand in, so the check still
// runs. Everything that can be unit-tested lives in `BriefingSynthesis`; this is the sequencing.
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
    case listening               // waiting for the repeat-back
    case grading
    case reasking([String])      // re-explaining the missed facts, about to listen again
    case passed
    case failed([String])        // still missed after the last round
    case unavailable(String)     // mic / speech recognition off

    var isActive: Bool {
      switch self {
      case .idle, .passed, .failed, .unavailable: false
      default: true
      }
    }
  }

  static let maxRounds = 3
  static let listenTimeout: Duration = .seconds(30)

  private(set) var phase: Phase = .idle
  private(set) var spoken: SpokenBriefing?
  private(set) var grade: AckGrade?
  private(set) var round = 0
  private(set) var heard = ""
  /// The "Briefing ack:" note produced by the last run (pass or fail), for the shift's first photo.
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
    round = 0
    heard = ""
    grade = nil
    ackNote = nil
    task = Task { [weak self] in
      guard let self else { return }
      await self.perform(briefing, wearer: wearer, generation: gen)
    }
  }

  /// Hear the wearer again with the same script (after a fail, or a bad take).
  func listenAgain(wearer: String) {
    guard let spoken, !phase.isActive else { return }
    generation += 1
    let gen = generation
    task = Task { [weak self] in
      guard let self else { return }
      await self.speaker.speakAndWait("Go ahead.")
      await self.listenAndGrade(spoken, wearer: wearer, generation: gen)
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
    log("must know: \(spoken.mustKnow)")

    phase = .speaking
    await speaker.speakAndWait(spoken.script)
    guard gen == generation else { return }

    if spoken.mustKnow.isEmpty {
      // Nothing to repeat back: a quiet floor. Hearing "okay" is enough.
      round = 1
      phase = .listening
      let said = await listen()
      guard gen == generation else { return }
      heard = said ?? ""
      finishPass(spoken, wearer: wearer, grade: AckGrade(covered: [], missed: []))
      return
    }
    await listenAndGrade(spoken, wearer: wearer, generation: gen)
  }

  private func listenAndGrade(_ spoken: SpokenBriefing, wearer: String, generation gen: Int) async {
    var missed = Array(spoken.mustKnow.indices)
    var allHeard: [String] = heard.isEmpty ? [] : [heard]
    var covered = Set(grade?.covered ?? [])
    if !covered.isEmpty { missed = missed.filter { !covered.contains($0) } }

    while round < Self.maxRounds {
      round += 1
      phase = .listening
      let said = await listen()
      guard gen == generation else { return }
      let text = said?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      log("round \(round) heard: \(text.isEmpty ? "(nothing)" : text)")
      if !text.isEmpty { allHeard.append(text) }
      heard = allHeard.joined(separator: " … ")

      phase = .grading
      let facts = missed.map { spoken.mustKnow[$0] }
      let partial = text.isEmpty ? AckGrade(covered: [], missed: Array(facts.indices)) : await gradeFacts(facts, heard: text)
      guard gen == generation else { return }
      for i in partial.covered { covered.insert(missed[i]) }
      missed = partial.missed.map { missed[$0] }
      grade = AckGrade(covered: covered.sorted(), missed: missed.sorted())
      log("round \(round) grade: covered \(covered.count)/\(spoken.mustKnow.count), missed \(missed)")

      if missed.isEmpty {
        finishPass(spoken, wearer: wearer, grade: grade!)
        return
      }
      if round < Self.maxRounds {
        let missedText = missed.map { spoken.mustKnow[$0] }
        phase = .reasking(missedText)
        await speaker.speakAndWait(BriefingSynthesis.reaskScript(missed: missedText, round: round))
        guard gen == generation else { return }
      }
    }
    let missedText = missed.map { spoken.mustKnow[$0] }
    ackNote = BriefingSynthesis.ackNote(wearer: wearer, grade: grade!, mustKnow: spoken.mustKnow, heard: heard, rounds: round, at: Date())
    phase = .failed(missedText)
    await speaker.speakAndWait(BriefingSynthesis.failScript(missed: missedText))
  }

  private func finishPass(_ spoken: SpokenBriefing, wearer: String, grade: AckGrade) {
    self.grade = grade
    let note = BriefingSynthesis.ackNote(wearer: wearer, grade: grade, mustKnow: spoken.mustKnow, heard: heard, rounds: max(round, 1), at: Date())
    ackNote = note
    phase = .passed
    log("passed after \(round) round(s)")
    Task { [weak self] in
      guard let self else { return }
      await self.speaker.speakAndWait(BriefingSynthesis.passScript(wearer: wearer))
      self.onPassed?(note)
    }
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

  private func gradeFacts(_ facts: [String], heard: String) async -> AckGrade {
    guard nvidia.hasKey else { return BriefingSynthesis.keywordGrade(mustKnow: facts, heard: heard) }
    do {
      let reply = try await nvidia.complete(system: BriefingSynthesis.gradeSystemPrompt,
                                            user: BriefingSynthesis.gradeUserPrompt(mustKnow: facts, heard: heard),
                                            maxTokens: 120, temperature: 0)
      if let grade = BriefingSynthesis.parseGrade(reply, count: facts.count) { return grade }
      log("Nemotron grade reply not parseable: \(reply.prefix(200))")
    } catch {
      log("Nemotron grade failed: \(error)")
    }
    return BriefingSynthesis.keywordGrade(mustKnow: facts, heard: heard)
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
