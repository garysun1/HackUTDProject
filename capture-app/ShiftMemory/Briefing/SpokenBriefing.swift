//
// SpokenBriefing.swift
// Shift Memory
//
// The spoken side of the shift briefing, as pure functions: the fact sheet Nemotron reads, the
// prompts that turn it into a short script plus the two or three things the wearer must be able to
// repeat back, the parsers for both replies, and the fallbacks when the model is unreachable (the
// template script and a keyword grade). Nothing here touches the network or the speaker, so all of
// it is unit-tested with hand-built briefings.
//

import Foundation

struct SpokenBriefing: Hashable, Sendable {
  enum Source: String, Hashable, Sendable { case nemotron, template }
  /// What is read aloud. Ends with the question that asks for the repeat-back.
  let script: String
  /// The facts the wearer must repeat back, in plain words, 1–3 of them.
  let mustKnow: [String]
  let source: Source
}

struct AckGrade: Hashable, Sendable {
  /// Indexes into `mustKnow`.
  let covered: [Int]
  let missed: [Int]
  var passed: Bool { missed.isEmpty }
}

enum BriefingSynthesis {
  static let maxMustKnow = 3
  static let askLine = "Now tell me the top things to watch, in your own words, so I know you've got it."

  // MARK: Fact sheet

  /// Everything the model may use, as numbered plain lines. No ids, no JSON.
  static func factSheet(_ b: Briefing, wearer: String, timeZone: TimeZone = .current) -> String {
    let time = DateFormatter()
    time.timeZone = timeZone
    time.dateFormat = "h:mm a"
    var lines: [String] = []
    lines.append("Wearer starting now: \(wearer).")
    lines.append("Window: since \(time.string(from: b.sinceDate)).")
    if let lead = b.leadText { lines.append("Handoff from the previous shift: \(lead)") }
    lines.append(b.needsYou.isEmpty ? "Open issues: none." : "Open issues (\(b.needsYou.count)):")
    for (i, item) in b.needsYou.prefix(6).enumerated() {
      var s = "  \(i + 1). [\(item.severity.rawValue)] \(item.title)"
      if !item.detail.isEmpty, item.detail != item.title { s += " — \(item.detail)" }
      if let place = item.place { s += " (at \(place.replacingOccurrences(of: " · ", with: ", ")))" }
      if let who = item.who, let when = item.when { s += ", seen by \(who) at \(time.string(from: when))" }
      lines.append(s + ".")
    }
    if !b.leftForYou.isEmpty {
      lines.append("What the previous people said:")
      for item in b.leftForYou.prefix(5) {
        let who = item.who ?? "Someone"
        let when = item.when.map { " at \(time.string(from: $0))" } ?? ""
        lines.append("  - \(who)\(when)\(item.isHandoffNote ? " (handoff)" : ""): \(item.title)")
      }
    }
    if !b.changed.isEmpty {
      lines.append("Changes on assets:")
      for item in b.changed.prefix(6) {
        var s = "  - \(item.title)"
        if !item.detail.isEmpty { s += ": \(item.detail)" }
        lines.append(s)
      }
    }
    if !b.quiet.isEmpty { lines.append("Not looked at in the window: \(b.quiet.prefix(8).joined(separator: ", ")).") }
    return lines.joined(separator: "\n")
  }

  // MARK: Prompts

  static let scriptSystemPrompt = """
  You brief a technician who is starting a shift on a data center floor. You get a fact sheet and \
  write what a calm, experienced lead would say out loud in about twenty seconds. Rules: plain spoken \
  English, short sentences, no lists, no markdown, no identifiers or codes, no greetings or sign-offs, \
  no invented facts. Lead with what needs action, say where it is and who saw it, then what the \
  previous shift said, then what changed. If nothing is open, say so in one sentence. 60 to 90 words. \
  Then pick the one to three facts the technician must be able to repeat back (an open issue and \
  where it is, a handoff instruction, a change that matters), each under twelve words. \
  Reply with JSON only: {"script": "...", "must_know": ["...", "..."]}.
  """

  static func scriptUserPrompt(factSheet: String) -> String {
    "Fact sheet:\n\(factSheet)\n\nWrite the briefing JSON now."
  }

  static let gradeSystemPrompt = """
  You check whether a technician understood a spoken shift briefing. You get the facts they had to \
  repeat back and a transcript of what they said (speech recognition, so expect misheard words and \
  no punctuation). A fact counts as covered when the transcript conveys its meaning, even loosely or \
  with different words, place names, or numbers said roughly right. Be generous about wording and \
  strict about substance. Reply with JSON only: {"covered": [indexes], "missed": [indexes]} using the \
  zero-based indexes of the facts.
  """

  static func gradeUserPrompt(mustKnow: [String], heard: String) -> String {
    let facts = mustKnow.enumerated().map { "\($0.offset). \($0.element)" }.joined(separator: "\n")
    return "Facts to repeat back:\n\(facts)\n\nTranscript:\n\"\(heard)\"\n\nGrade JSON now."
  }

  // MARK: Parsing

  /// Tolerant of code fences and prose around the JSON object.
  static func parseScript(_ text: String) -> SpokenBriefing? {
    guard let object = firstJSONObject(in: text),
          let script = (object["script"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !script.isEmpty else { return nil }
    let must = ((object["must_know"] as? [Any]) ?? [])
      .compactMap { ($0 as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) }
      .filter { !$0.isEmpty }
      .prefix(maxMustKnow)
    return SpokenBriefing(script: finished(script) + " " + askLine, mustKnow: Array(must), source: .nemotron)
  }

  static func parseGrade(_ text: String, count: Int) -> AckGrade? {
    guard let object = firstJSONObject(in: text) else { return nil }
    func ints(_ key: String) -> [Int] {
      ((object[key] as? [Any]) ?? []).compactMap { v -> Int? in
        if let n = v as? Int { return n }
        if let n = v as? Double { return Int(n) }
        if let s = v as? String { return Int(s) }
        return nil
      }.filter { (0..<count).contains($0) }
    }
    let covered = Set(ints("covered"))
    var missed = Set(ints("missed")).subtracting(covered)
    // Anything the model left out of both lists counts as missed: the wearer did not say it.
    for i in 0..<count where !covered.contains(i) { missed.insert(i) }
    return AckGrade(covered: covered.sorted(), missed: missed.sorted())
  }

  static func firstJSONObject(in text: String) -> [String: Any]? {
    guard let open = text.firstIndex(of: "{"), let close = text.lastIndex(of: "}"), open < close else { return nil }
    let slice = text[open...close]
    guard let data = slice.data(using: .utf8),
          let any = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return any
  }

  // MARK: Fallbacks (no model)

  /// The template script from `BriefingBuilder`, re-pointed at the spoken question, with the open
  /// issues (and the handoff) as the facts to repeat.
  static func template(_ b: Briefing) -> SpokenBriefing {
    var script = b.spokenScript
    if let r = script.range(of: "Tap Got it when you're ready.") { script.removeSubrange(r) }
    script = script.trimmingCharacters(in: .whitespacesAndNewlines)
    var must: [String] = []
    for item in b.needsYou.prefix(maxMustKnow) {
      var s = item.title
      if let place = item.place { s += " at \(place.replacingOccurrences(of: " · ", with: " "))" }
      must.append(s)
    }
    if must.count < maxMustKnow, let lead = b.leadText ?? b.leftForYou.first(where: \.isHandoffNote)?.title {
      must.append(clipWords(lead, 12))
    }
    return SpokenBriefing(script: (script.isEmpty ? "" : script + " ") + askLine, mustKnow: must, source: .template)
  }

  /// A fact is covered when the wearer said at least half of its distinctive words (two at most).
  static func keywordGrade(mustKnow: [String], heard: String) -> AckGrade {
    let said = Set(significantWords(heard))
    var covered: [Int] = []
    var missed: [Int] = []
    for (i, fact) in mustKnow.enumerated() {
      let words = significantWords(fact)
      if words.isEmpty { covered.append(i); continue }
      let hits = words.filter { said.contains($0) }.count
      let need = max(1, min(2, Int((Double(words.count) * 0.5).rounded(.up))))
      if hits >= need { covered.append(i) } else { missed.append(i) }
    }
    return AckGrade(covered: covered, missed: missed)
  }

  static let stopWords: Set<String> = [
    "the", "a", "an", "and", "or", "of", "at", "in", "on", "to", "is", "are", "was", "were", "it", "its", "this",
    "that", "with", "for", "by", "from", "be", "has", "have", "had", "not", "no", "as", "but", "so", "if", "then",
    "there", "here", "you", "your", "we", "i", "they", "them", "he", "she", "check", "please", "still", "now",
    "row", "rack", "one", "two", "three", "issue", "issues", "open", "handoff", "said", "seen", "saw",
  ]

  static func significantWords(_ s: String) -> [String] {
    s.lowercased()
      .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
      .map(String.init)
      .filter { $0.count > 2 && !stopWords.contains($0) }
  }

  // MARK: Follow-ups and the note

  static func reaskScript(missed: [String], round: Int) -> String {
    let lead = round == 1 ? "Almost. One more time on these." : "Last pass, just these."
    let items = missed.map { finished($0) }.joined(separator: " ")
    return "\(lead) \(items) Say those back to me."
  }

  static func passScript(wearer: String) -> String {
    let name = wearer.trimmingCharacters(in: .whitespaces)
    return name.isEmpty || name.lowercased() == "you" ? "That's it. You're up to speed. Starting your shift."
                                                      : "That's it, \(name). You're up to speed. Starting your shift."
  }

  static func failScript(missed: [String]) -> String {
    "I'll leave these on screen for you to check off: " + missed.map { finished($0) }.joined(separator: " ")
  }

  /// The note stored with the shift's first photo so the acknowledgement reaches the graph.
  static func ackNote(wearer: String, grade: AckGrade, mustKnow: [String], heard: String, rounds: Int, at: Date,
                      timeZone: TimeZone = .current) -> String {
    let time = DateFormatter()
    time.timeZone = timeZone
    time.dateFormat = "h:mm a"
    let who = wearer.isEmpty || wearer.lowercased() == "you" ? "Wearer" : wearer
    var s = "Briefing ack: \(who) \(grade.passed ? "confirmed" : "partly confirmed") the briefing at \(time.string(from: at))"
    s += rounds > 1 ? " after \(rounds) passes." : "."
    let covered = grade.covered.compactMap { mustKnow[safe: $0] }
    let missed = grade.missed.compactMap { mustKnow[safe: $0] }
    if !covered.isEmpty { s += " Repeated back: " + covered.map { finished($0) }.joined(separator: " ") }
    if !missed.isEmpty { s += " Not repeated: " + missed.map { finished($0) }.joined(separator: " ") }
    let heardTrim = heard.trimmingCharacters(in: .whitespacesAndNewlines)
    if !heardTrim.isEmpty { s += " Said: “\(clipWords(heardTrim, 40))”" }
    return s
  }

  // MARK: Helpers

  static func finished(_ s: String) -> String {
    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let last = t.last else { return t }
    return ".!?".contains(last) ? t : t + "."
  }

  static func clipWords(_ s: String, _ n: Int) -> String {
    let words = s.split(whereSeparator: { $0.isWhitespace })
    return words.count <= n ? s : words.prefix(n).joined(separator: " ") + "…"
  }
}
