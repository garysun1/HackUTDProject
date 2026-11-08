//
// SpokenBriefing.swift
// Shift Memory
//
// The spoken side of the shift briefing, as pure functions: the fact sheet Nemotron reads, the
// prompt that turns it into a short script, its tolerant parser, the template script used when the
// model is unreachable, the "yes" detector for the wearer's answer, the re-prompt lines, and the
// "Briefing ack:" note. Every script ends with the same question. Nothing here touches the network
// or the speaker, so all of it is unit-tested with hand-built briefings.
//

import Foundation

struct SpokenBriefing: Hashable, Sendable {
  enum Source: String, Hashable, Sendable { case nemotron, template }
  /// What is read aloud. Ends with `BriefingSynthesis.askLine`.
  let script: String
  let source: Source
}

enum BriefingSynthesis {
  static let askLine = "Does that make sense?"

  // MARK: Fact sheet

  /// Everything the model may use, as plain lines. No ids, no JSON.
  static func factSheet(_ b: Briefing, wearer: String, timeZone: TimeZone = .current) -> String {
    let time = DateFormatter()
    time.timeZone = timeZone
    time.dateFormat = "h:mm a"
    var lines: [String] = []
    lines.append("Wearer starting now: \(wearer.isEmpty ? "unknown" : wearer).")
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

  // MARK: Nemotron

  static let scriptSystemPrompt = """
  You brief a technician who is starting a shift on a data center floor. You get a fact sheet and \
  write what a calm, experienced lead would say out loud in about twenty seconds. Rules: plain spoken \
  English, short sentences, no lists, no markdown, no identifiers or codes, no greetings, no closing \
  question, no invented facts. Lead with what needs action, say where it is and who saw it, then what \
  the previous shift said, then what changed. If nothing is open, say so in one sentence. 50 to 90 \
  words. Reply with JSON only: {"script": "..."}.
  """

  static func scriptUserPrompt(factSheet: String) -> String {
    "Fact sheet:\n\(factSheet)\n\nWrite the briefing JSON now."
  }

  /// Tolerant of code fences and prose around the JSON object; always ends with the question.
  static func parseScript(_ text: String) -> SpokenBriefing? {
    guard let object = firstJSONObject(in: text),
          let script = (object["script"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
          !script.isEmpty else { return nil }
    return SpokenBriefing(script: withQuestion(script), source: .nemotron)
  }

  static func firstJSONObject(in text: String) -> [String: Any]? {
    guard let open = text.firstIndex(of: "{"), let close = text.lastIndex(of: "}"), open < close else { return nil }
    guard let data = text[open...close].data(using: .utf8),
          let any = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
    return any
  }

  // MARK: Template (no model)

  /// `BriefingBuilder`'s script with its tap line replaced by the question.
  static func template(_ b: Briefing) -> SpokenBriefing {
    var script = b.spokenScript
    if let r = script.range(of: "Tap Got it when you're ready.") { script.removeSubrange(r) }
    return SpokenBriefing(script: withQuestion(script), source: .template)
  }

  static func withQuestion(_ script: String) -> String {
    var s = script.trimmingCharacters(in: .whitespacesAndNewlines)
    if s.hasSuffix(askLine) { return s }
    if !s.isEmpty { s = finished(s) + " " }
    return s + askLine
  }

  // MARK: The answer

  static let yesWords: Set<String> = [
    "yes", "yeah", "yep", "yup", "ya", "yah", "sure", "okay", "ok", "kay", "alright", "right", "affirmative",
    "understood", "copy", "roger", "absolutely", "definitely", "correct", "perfect", "cool", "good", "fine", "clear",
  ]
  static let yesPhrases: [String] = [
    "makes sense", "make sense", "got it", "i got it", "i understand", "understand", "i'm good", "im good", "all good",
    "sounds good", "that works", "i hear you", "heard", "will do", "on it", "copy that", "no problem", "no questions",
    "i'm ready", "im ready", "ready", "let's go", "lets go",
  ]
  static let noWords: Set<String> = ["no", "nope", "nah", "not", "don't", "dont", "didn't", "didnt", "can't", "cant", "unclear", "confused", "what", "repeat", "again", "huh", "sorry", "pardon"]

  enum Answer: Equatable { case yes, no, unclear }

  /// A yes when an affirmative word or phrase is said and nothing negative is; a no when a negative
  /// is; unclear otherwise (silence, mumble, an unrelated remark).
  static func answer(_ heard: String?) -> Answer {
    guard let heard else { return .unclear }
    let lowered = heard.lowercased().replacingOccurrences(of: "’", with: "'")
    let words = lowered.split(whereSeparator: { !$0.isLetter && $0 != "'" }).map(String.init)
    guard !words.isEmpty else { return .unclear }
    let negative = words.contains(where: { noWords.contains($0) })
    let positive = words.contains(where: { yesWords.contains($0) }) || yesPhrases.contains(where: { lowered.contains($0) })
    if negative { return .no }
    return positive ? .yes : .unclear
  }

  // MARK: Lines

  static func repromptScript(round: Int, answer: Answer) -> String {
    switch (answer, round) {
    case (.no, _): "No problem. Take a look at the screen, then say yes when it makes sense."
    case (_, 1): "Still there? Say yes when that makes sense."
    case (_, 2): "Does that make sense? Just say yes."
    default: "Say yes when you're ready, or check it off on the screen."
    }
  }

  static func passScript(wearer: String) -> String {
    let name = wearer.trimmingCharacters(in: .whitespaces)
    return name.isEmpty || name.lowercased() == "you" ? "Good. You're up to speed. Starting your shift."
                                                      : "Good, \(name). You're up to speed. Starting your shift."
  }

  /// The note stored with the shift's first photo so the acknowledgement reaches the graph.
  static func ackNote(wearer: String, heard: String, prompts: Int, openItems: Int, at: Date, timeZone: TimeZone = .current) -> String {
    let time = DateFormatter()
    time.timeZone = timeZone
    time.dateFormat = "h:mm a"
    let who = wearer.isEmpty || wearer.lowercased() == "you" ? "Wearer" : wearer
    var s = "Briefing ack: \(who) heard the shift briefing"
    s += openItems == 0 ? " (nothing open)" : " (\(openItems) open \(openItems == 1 ? "issue" : "issues"))"
    s += " and confirmed it at \(time.string(from: at))"
    s += prompts > 1 ? " after \(prompts) prompts." : "."
    let said = heard.trimmingCharacters(in: .whitespacesAndNewlines)
    if !said.isEmpty { s += " Said: “\(clipWords(said, 30))”" }
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
