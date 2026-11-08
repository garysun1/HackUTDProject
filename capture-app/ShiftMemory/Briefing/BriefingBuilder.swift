//
// BriefingBuilder.swift
// Shift Memory
//
// The shift-start briefing: "where am I starting from", in plain language, built from one
// FloorSnapshot. Pure and Sendable so it is unit-tested with hand-built snapshots and can run off
// the main actor. Four buckets: what needs you (open issues, where they are, who saw them), what
// the previous people said out loud (their notes, "Handoff:" first), what changed on assets, and
// which assets nobody looked at. Plus one honest headline and a short script for text-to-speech.
//

import Foundation

struct BriefingItem: Identifiable, Hashable, Sendable {
  enum Severity: String, Hashable, Sendable { case critical, warning, info }

  let id: String
  let title: String
  let detail: String
  let place: String?        // "Row 1 · Rack R12"
  let who: String?
  let when: Date?
  let eventId: String?
  let issueId: UInt64?
  let severity: Severity
}

extension BriefingItem {
  /// A note the wearer opened with "Handoff:" (shown first, prefix stripped).
  var isHandoffNote: Bool { id.hasPrefix("handoff-") }
}

struct Briefing: Sendable, Hashable {
  let headline: String
  /// The module's generated handoff text, when one exists newer than the window.
  let leadText: String?
  let leadGeneratedAt: Date?
  let needsYou: [BriefingItem]
  let leftForYou: [BriefingItem]
  let changed: [BriefingItem]
  /// Registry assets nobody photographed in the window, by display name.
  let quiet: [String]
  let spokenScript: String
  let sinceDate: Date
  let generatedAt: Date
}

enum BriefingBuilder {
  static let handoffPrefix = "handoff:"

  static func build(snapshot: FloorSnapshot, myDeviceId: String, myName: String, since: Date, now: Date,
                    handoffText: String?, handoffGeneratedAt: Date? = nil,
                    timeZone: TimeZone = .current) -> Briefing {
    // No upper bound: event times are the server's receive time, and a phone clock a few seconds
    // behind the server must not hide the newest events.
    let inWindow: (Date) -> Bool = { $0 >= since }
    let eventsById = Dictionary(snapshot.events.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
    let windowEvents = snapshot.events.filter { inWindow($0.at) }

    // Needs you: open issues, newest first.
    let open = snapshot.openIssues
    let needsYou: [BriefingItem] = uniqued(open.map { issue in
      let asset = snapshot.asset(forIssue: issue)
      let name = displayName(asset: asset, fallback: issue.entityName.nilIfEmpty ?? issue.entityId)
      let source = eventsById[issue.eventId]
      let detail = [source?.summary.trimmed.nilIfEmpty, source?.note.map(stripHandoff)?.nilIfEmpty.map { "Note: \($0)" }]
        .compactMap { $0 }.joined(separator: "\n")
      let who = issue.wearerName.trimmed.nilIfEmpty ?? snapshot.wearerName(issue.deviceId).nilIfEmpty
      return BriefingItem(
        id: "issue-\(issue.id)", title: "\(name): \(issue.text.trimmed)", detail: detail,
        place: asset.flatMap { placeText($0.place) }, who: who, when: issue.at,
        eventId: issue.eventId.nilIfEmpty, issueId: issue.id, severity: severity(of: issue))
    })

    // Left for you: what other people said out loud, handoff notes first, newest first within each.
    let notes: [(event: FloorEvent, note: String)] = windowEvents
      .filter { $0.deviceId != myDeviceId }
      .compactMap { e in e.note?.trimmed.nilIfEmpty.map { (e, $0) } }
      .filter { !stripHandoff($0.note).isEmpty }
      .sorted { $0.event.at > $1.event.at }
    let sortedNotes = notes.filter { isHandoff($0.note) } + notes.filter { !isHandoff($0.note) }
    let leftForYou: [BriefingItem] = uniqued(sortedNotes.map { e, note in
      let asset = (snapshot.involvesAsset[e.id] ?? []).sorted().compactMap { snapshot.assetForEntity[$0] }.first
        ?? e.label.flatMap { FloorGeometry.match(name: $0, in: snapshot.assets) }
      return BriefingItem(
        id: (isHandoff(note) ? "handoff-" : "note-") + e.id, title: stripHandoff(note), detail: e.summary.trimmed,
        place: asset.flatMap { placeText($0.place) }, who: snapshot.wearerName(e.deviceId), when: e.at,
        eventId: e.id, issueId: nil, severity: .info)
    })

    // What changed: asset state changes in the window (latest per entity+attr), and resolutions.
    var latest: [String: (FloorChange, FloorEvent, FloorAsset)] = [:]
    for c in snapshot.changes {
      guard c.entityId.lowercased() != "scene", let asset = snapshot.assetForEntity[c.entityId],
            let e = eventsById[c.eventId], inWindow(e.at) else { continue }
      let key = "\(c.entityId)|\(c.attr.lowercased())"
      if let prev = latest[key], prev.1.at >= e.at { continue }
      latest[key] = (c, e, asset)
    }
    var changed: [BriefingItem] = latest.values.map { c, e, asset in
      let attr = c.attr.trimmed.nilIfEmpty ?? "State"
      let from = c.from.trimmed.nilIfEmpty ?? "?"
      let to = c.to.trimmed.nilIfEmpty ?? "?"
      return BriefingItem(
        id: "change-\(c.entityId)|\(c.attr.lowercased())", title: "\(attr): \(from) → \(to)", detail: asset.name,
        place: placeText(asset.place), who: snapshot.wearerName(e.deviceId), when: e.at,
        eventId: e.id, issueId: nil, severity: looksBad(to) ? .critical : .info)
    }
    for issue in snapshot.issues where issue.isResolved {
      guard let at = issue.resolvedAt, inWindow(at) else { continue }
      let asset = snapshot.asset(forIssue: issue)
      let name = displayName(asset: asset, fallback: issue.entityName.nilIfEmpty ?? issue.entityId)
      changed.append(BriefingItem(
        id: "resolved-\(issue.id)", title: "Resolved: \(name)", detail: issue.text.trimmed,
        place: asset.flatMap { placeText($0.place) }, who: nil, when: at,
        eventId: issue.eventId.nilIfEmpty, issueId: issue.id, severity: .info))
    }
    changed.sort { ($0.when ?? .distantPast, $0.id) > ($1.when ?? .distantPast, $1.id) }
    changed = uniqued(changed)

    // Quiet: registry assets with no event in the window.
    let quiet = snapshot.assets.filter { asset in
      !snapshot.events(for: asset).contains { inWindow($0.at) }
    }.map(\.name).sorted { $0.localizedStandardCompare($1) == .orderedAscending }

    let lead = handoffText?.trimmed.nilIfEmpty
    let headline = makeHeadline(open: open, snapshot: snapshot, leftForYou: leftForYou, hasLead: lead != nil)
    let script = makeScript(needsYou: needsYou, leftForYou: leftForYou, changed: changed, lead: lead,
                            since: since, timeZone: timeZone, scrub: Array(eventsById.keys) + open.map(\.eventId))
    _ = myName  // reserved: the headline speaks about others by name, never "you" by name
    return Briefing(headline: headline, leadText: lead, leadGeneratedAt: lead == nil ? nil : handoffGeneratedAt,
                    needsYou: needsYou, leftForYou: leftForYou, changed: changed, quiet: quiet,
                    spokenScript: script, sinceDate: since, generatedAt: now)
  }

  // MARK: - Headline

  static func makeHeadline(open: [FloorIssue], snapshot: FloorSnapshot, leftForYou: [BriefingItem], hasLead: Bool) -> String {
    var parts: [String] = []
    if open.isEmpty {
      parts.append("Nothing open.")
    } else {
      let rows = Set(open.map { snapshot.asset(forIssue: $0).map { $0.place.row ?? $0.place.zone ?? "" } ?? "" })
      let count = open.count == 1 ? "1 open issue" : "\(open.count) open issues"
      if rows.count == 1, let only = rows.first, !only.isEmpty {
        parts.append("\(count) \(only.lowercased().hasPrefix("row") ? "on" : "in") \(only).")
      } else if rows.count > 1, !rows.contains("") {
        parts.append("\(count) across \(rows.count) areas.")
      } else {
        parts.append("\(count).")
      }
    }
    if hasLead {
      parts.append("There's a handoff from the last shift.")
    } else if let first = leftForYou.first {
      let who = first.who ?? "Someone"
      let people = Set(leftForYou.compactMap(\.who))
      if leftForYou.count == 1 {
        parts.append(first.isHandoffNote ? "\(who) left you a handoff note." : "\(who) left you a note.")
      } else if people.count == 1 {
        parts.append("\(who) left you \(leftForYou.count) notes.")
      } else {
        parts.append(first.isHandoffNote ? "\(who) left you a handoff note, plus \(leftForYou.count - 1) more notes."
                                         : "\(people.count) people left you \(leftForYou.count) notes.")
      }
    } else if open.isEmpty {
      parts.append("Last shift ended quietly.")
    }
    return parts.joined(separator: " ")
  }

  // MARK: - Spoken script

  static func makeScript(needsYou: [BriefingItem], leftForYou: [BriefingItem], changed: [BriefingItem], lead: String?,
                         since: Date, timeZone: TimeZone, scrub: [String]) -> String {
    let spokenTime = formatter("h:mm a", timeZone)
    var sentences: [String] = []
    if needsYou.isEmpty {
      sentences.append("Nothing is open right now.")
    } else {
      sentences.append(needsYou.count == 1 ? "One issue needs you." : "\(needsYou.count) issues need you.")
      for item in needsYou.prefix(2) {
        var s = speakable(item.title)
        if let place = item.place { s += ", at \(place.replacingOccurrences(of: " · ", with: ", "))" }
        if let who = item.who, let when = item.when { s += ". \(who) saw it at \(spokenTime.string(from: when))" }
        sentences.append(clip(s, words: 22) + ".")
      }
      if needsYou.count > 2 { sentences.append("And \(needsYou.count - 2) more on screen.") }
    }
    if let lead {
      sentences.append("From the handoff: " + clip(speakable(lead), words: 25) + ".")
    } else if let note = leftForYou.first {
      sentences.append("\(note.who ?? "Someone") said: " + clip(speakable(note.title), words: 20) + ".")
      if leftForYou.count > 1 { sentences.append("\(leftForYou.count - 1) more notes are on screen.") }
    }
    let resolved = changed.filter { $0.id.hasPrefix("resolved-") }.count
    let changes = changed.count - resolved
    if changes > 0 {
      sentences.append(changes == 1 ? "One asset changed since \(spokenTime.string(from: since))."
                                    : "\(changes) asset readings changed since \(spokenTime.string(from: since)).")
    }
    if resolved > 0 { sentences.append(resolved == 1 ? "One issue was resolved." : "\(resolved) issues were resolved.") }

    let closing = "Tap Got it when you're ready."
    var out: [String] = []
    var words = wordCount(closing)
    for s in sentences {
      let clean = scrubIds(s, ids: scrub)
      let n = wordCount(clean)
      if words + n > 90 { break }
      out.append(clean)
      words += n
    }
    out.append(closing)
    return out.joined(separator: " ")
  }

  // MARK: - Helpers

  static func placeText(_ place: FloorPlace) -> String? {
    var parts: [String] = []
    if let row = place.row { parts.append(place.isRowEnd ? "\(row) end" : row) }
    if let rack = place.rack { parts.append("Rack \(rack)") }
    if parts.isEmpty, let zone = place.zone, zone != "Unplaced" { parts.append(zone) }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  static func isHandoff(_ note: String) -> Bool { note.trimmed.lowercased().hasPrefix(handoffPrefix) }

  static func stripHandoff(_ note: String) -> String {
    let t = note.trimmed
    guard isHandoff(t) else { return t }
    return String(t.dropFirst(handoffPrefix.count)).trimmed
  }

  static func severity(of issue: FloorIssue) -> BriefingItem.Severity {
    if issue.kind == "anomaly" { return .warning }
    return looksBad(issue.text) || issue.kind == "state_change" ? .critical : .warning
  }

  static func looksBad(_ text: String) -> Bool {
    let t = text.lowercased()
    return ["fault", "fail", "down", "alarm", "critical", "error", "offline", "tripped", "leak", "smoke"]
      .contains { t.contains($0) }
  }

  private static func displayName(asset: FloorAsset?, fallback: String) -> String {
    asset?.name.trimmed.nilIfEmpty ?? fallback.trimmed.nilIfEmpty ?? "Unknown asset"
  }

  private static func formatter(_ format: String, _ tz: TimeZone) -> DateFormatter {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = tz
    f.dateFormat = format
    if format.contains("a") { f.amSymbol = "AM"; f.pmSymbol = "PM" }
    return f
  }

  private static func speakable(_ s: String) -> String {
    var t = s.replacingOccurrences(of: "→", with: " to ").replacingOccurrences(of: "·", with: ",")
    t = String(t.unicodeScalars.filter { !$0.properties.isEmojiPresentation }.map(Character.init))
    t = t.replacingOccurrences(of: "\n", with: " ")
    while t.contains("  ") { t = t.replacingOccurrences(of: "  ", with: " ") }
    return t.trimmed.trimmingCharacters(in: CharacterSet(charactersIn: ".!?"))
  }

  private static func clip(_ s: String, words: Int) -> String {
    let parts = s.split(separator: " ")
    return parts.count <= words ? s : parts.prefix(words).joined(separator: " ")
  }

  /// Item ids drive ForEach identity and the view's check-offs, so they must be unique even when the
  /// module returns duplicate keys (e.g. alert_id 0 from a row that failed to decode).
  private static func uniqued(_ items: [BriefingItem]) -> [BriefingItem] {
    var seen: [String: Int] = [:]
    return items.map { item in
      let n = seen[item.id, default: 0]
      seen[item.id] = n + 1
      guard n > 0 else { return item }
      return BriefingItem(id: "\(item.id)#\(n)", title: item.title, detail: item.detail, place: item.place,
                          who: item.who, when: item.when, eventId: item.eventId, issueId: item.issueId,
                          severity: item.severity)
    }
  }

  private static func scrubIds(_ s: String, ids: [String]) -> String {
    var t = s
    for id in ids where id.count >= 4 { t = t.replacingOccurrences(of: id, with: "") }
    while t.contains("  ") { t = t.replacingOccurrences(of: "  ", with: " ") }
    return t
  }

  static func wordCount(_ s: String) -> Int { s.split(whereSeparator: { $0.isWhitespace }).count }
}

private extension String {
  var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
