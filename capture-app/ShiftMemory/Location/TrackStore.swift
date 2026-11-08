//
// TrackStore.swift
// Shift Memory
//
// The on-phone record of where the wearer walked during a shift (contract v3.1, issue #20). Every
// kept fix lands in two append-only JSON Lines files under `directory/`:
//   history/<shift>.jsonl  everything recorded for that shift, sent or not; the source for export
//                          and for the shift map. Kept `retention` (7 days) after its last write.
//   pending.jsonl          a journal of what `ingest_track` has not acknowledged yet: one line per
//                          point or mark (with a sequence number) and one `ack` line per confirmed
//                          or dropped batch. Replayed on first use, compacted when it grows.
// Appends go through FileHandle so a crash loses at most the line being written; a torn last line
// is skipped on read and newline-terminated before the next append. Recording never blocks: past
// `capacity` pending points the OLDEST pending points are dropped from the upload set (they stay in
// history). The module deduplicates on (device_id, t), so a batch resent after a lost reply is safe.
//

import Foundation

struct TrackPoint: Codable, Sendable, Hashable {
  let shiftId: String
  let fix: LocationFix
}

struct TrackMark: Codable, Sendable, Hashable {
  /// `shift_start` | `shift_end`
  static let shiftStart = "shift_start"
  static let shiftEnd = "shift_end"

  let shiftId: String
  let kind: String
  let t: Date
}

/// The oldest unsent items of one shift. The sequence numbers identify exactly what to drop from
/// the pending journal once `ingest_track` acknowledged the batch.
struct TrackBatch: Sendable {
  let shiftId: String
  let points: [TrackPoint]
  let marks: [TrackMark]
  let pointSeqs: [Int]
  let markSeqs: [Int]

  var isEmpty: Bool { points.isEmpty && marks.isEmpty }
}

actor TrackStore {
  private let directory: URL
  private let capacity: Int
  private let retention: TimeInterval

  /// One line of either file. `op`: `p` point, `m` mark, `ack` acknowledged or dropped seqs,
  /// `seq` the next sequence number (first line of a compacted journal).
  private struct Line: Codable {
    var op: String
    var seq: Int?
    var shift: String?
    var fix: LocationFix?
    var kind: String?
    var t: Date?
    var seqs: [Int]?
  }

  /// Pending items in append (seq) order; seqs only ever grow, so appending keeps them sorted.
  private var pendingPoints: [(seq: Int, point: TrackPoint)] = []
  private var pendingMarks: [(seq: Int, mark: TrackMark)] = []
  private var nextSeq = 1
  private var journalLines = 0
  private var loaded = false
  /// Points per shift in history, filled lazily (a shift's file is counted the first time it is asked for).
  private var recordedCounts: [String: Int] = [:]
  /// Files whose tail was checked for a torn line in this process.
  private var checkedTails: Set<String> = []
  private var droppedSinceLog = 0

  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  private nonisolated func log(_ message: String) { DebugLog.write("TrackStore", message) }

  /// Nothing is read here; the journal is replayed on the first call.
  init(directory: URL, capacity: Int = 20_000, retention: TimeInterval = 7 * 24 * 3600) {
    self.directory = directory
    self.capacity = max(1, capacity)
    self.retention = retention
  }

  // MARK: - Paths

  nonisolated static func journalURL(directory: URL) -> URL { directory.appending(path: "pending.jsonl") }

  nonisolated static func historyDirectory(_ directory: URL) -> URL { directory.appending(path: "history", directoryHint: .isDirectory) }

  /// The shift id percent-encoded to a safe file name (UUIDs come through unchanged).
  nonisolated static func historyURL(directory: URL, shiftId: String) -> URL {
    var allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_")
    allowed.remove(charactersIn: "%")
    let name = shiftId.addingPercentEncoding(withAllowedCharacters: allowed) ?? shiftId
    return historyDirectory(directory).appending(path: "\(name).jsonl")
  }

  private var journalURL: URL { Self.journalURL(directory: directory) }

  // MARK: - Recording

  /// Records one kept fix: into the shift's history and the pending upload set.
  func append(_ rawFix: LocationFix, shiftId: String) {
    ensureLoaded()
    guard Self.isPlausible(rawFix), !shiftId.isEmpty else {
      log("ignoring implausible fix lat=\(rawFix.lat) lon=\(rawFix.lon) acc=\(rawFix.accuracyM)")
      return
    }
    // A NaN / infinite optional would make JSONEncoder throw and the line silently vanish from disk.
    var fix = rawFix
    if fix.altM?.isFinite == false || fix.altAccuracyM?.isFinite == false { fix.altM = nil; fix.altAccuracyM = nil }
    if fix.speedMps?.isFinite == false { fix.speedMps = nil }
    if fix.courseDeg?.isFinite == false { fix.courseDeg = nil }
    let seq = takeSeq()
    let point = TrackPoint(shiftId: shiftId, fix: fix)
    appendLines([Line(op: "p", fix: fix)], to: Self.historyURL(directory: directory, shiftId: shiftId))
    if recordedCounts[shiftId] != nil { recordedCounts[shiftId]! += 1 }
    appendJournal([Line(op: "p", seq: seq, shift: shiftId, fix: fix)])
    pendingPoints.append((seq, point))
    enforceCapacity()
  }

  /// Records a `shift_start` / `shift_end` mark. Marks are never dropped for capacity. Any other
  /// kind is refused here: the module would reject the whole batch and stall the upload. A shift
  /// start also prunes history past `retention`, so an app left running for days still forgets.
  func mark(_ kind: String, shiftId: String, at t: Date) {
    ensureLoaded()
    guard !shiftId.isEmpty, kind == TrackMark.shiftStart || kind == TrackMark.shiftEnd else {
      log("ignoring mark kind=\(kind) shift=\(shiftId.prefix(8))")
      return
    }
    if kind == TrackMark.shiftStart { clearHistory(olderThan: Date().addingTimeInterval(-retention)) }
    let seq = takeSeq()
    appendLines([Line(op: "m", kind: kind, t: t)], to: Self.historyURL(directory: directory, shiftId: shiftId))
    appendJournal([Line(op: "m", seq: seq, shift: shiftId, kind: kind, t: t)])
    pendingMarks.append((seq, TrackMark(shiftId: shiftId, kind: kind, t: t)))
  }

  // MARK: - Upload set

  /// The oldest unsent items of ONE shift (the shift of the oldest pending item): up to `maxPoints`
  /// points in time order, plus that shift's pending marks up to the last point's time (all of
  /// them once the batch carries the shift's remaining points). Nil when nothing is pending.
  func nextBatch(maxPoints: Int = 200) -> TrackBatch? {
    ensureLoaded()
    let limit = max(1, maxPoints)
    let oldestPoint = pendingPoints.first
    let oldestMark = pendingMarks.first
    let shiftId: String
    switch (oldestPoint, oldestMark) {
    case (nil, nil): return nil
    case (let p?, nil): shiftId = p.point.shiftId
    case (nil, let m?): shiftId = m.mark.shiftId
    case (let p?, let m?): shiftId = p.seq < m.seq ? p.point.shiftId : m.mark.shiftId
    }

    let shiftPoints = pendingPoints
      .filter { $0.point.shiftId == shiftId }
      .sorted { ($0.point.fix.t, $0.seq) < ($1.point.fix.t, $1.seq) }
    let points = Array(shiftPoints.prefix(limit))
    let carriesAllPoints = points.count == shiftPoints.count
    let cutoff = points.last?.point.fix.t
    let marks = pendingMarks
      .filter { item in
        item.mark.shiftId == shiftId && (carriesAllPoints || cutoff.map { item.mark.t <= $0 } ?? true)
      }
      .sorted { ($0.mark.t, $0.seq) < ($1.mark.t, $1.seq) }
    return TrackBatch(
      shiftId: shiftId,
      points: points.map(\.point),
      marks: marks.map(\.mark),
      pointSeqs: points.map(\.seq),
      markSeqs: marks.map(\.seq)
    )
  }

  /// Drops an acknowledged batch from the pending set. History keeps every item for export.
  func confirm(_ batch: TrackBatch) {
    ensureLoaded()
    let done = Set(batch.pointSeqs).union(batch.markSeqs)
    guard !done.isEmpty else { return }
    pendingPoints.removeAll { done.contains($0.seq) }
    pendingMarks.removeAll { done.contains($0.seq) }
    appendJournal([Line(op: "ack", seqs: done.sorted())])
    compactIfNeeded()
  }

  func pendingCount() -> Int {
    ensureLoaded()
    return pendingPoints.count + pendingMarks.count
  }

  // MARK: - History

  /// Points recorded for the shift (sent or not).
  func recordedCount(shiftId: String) -> Int {
    ensureLoaded()
    if let count = recordedCounts[shiftId] { return count }
    let count = readLines(Self.historyURL(directory: directory, shiftId: shiftId)).filter { $0.op == "p" }.count
    recordedCounts[shiftId] = count
    return count
  }

  /// Everything recorded for the shift, sent or not, each list in time order.
  func history(shiftId: String) -> (points: [TrackPoint], marks: [TrackMark]) {
    ensureLoaded()
    var points: [TrackPoint] = []
    var marks: [TrackMark] = []
    for line in readLines(Self.historyURL(directory: directory, shiftId: shiftId)) {
      switch line.op {
      case "p": if let fix = line.fix { points.append(TrackPoint(shiftId: shiftId, fix: fix)) }
      case "m": if let kind = line.kind, let t = line.t { marks.append(TrackMark(shiftId: shiftId, kind: kind, t: t)) }
      default: break
      }
    }
    recordedCounts[shiftId] = points.count
    // Stable sort: equal timestamps keep their recording order.
    let orderedPoints = points.enumerated().sorted { ($0.element.fix.t, $0.offset) < ($1.element.fix.t, $1.offset) }.map(\.element)
    let orderedMarks = marks.enumerated().sorted { ($0.element.t, $0.offset) < ($1.element.t, $1.offset) }.map(\.element)
    return (orderedPoints, orderedMarks)
  }

  /// Shifts with a history file, most recently written first.
  func shiftIds() -> [String] {
    ensureLoaded()
    return historyFiles()
      .sorted { $0.modified > $1.modified }
      .map(\.shiftId)
  }

  /// Deletes history files not written since `cutoff`. A shift that still has pending items keeps
  /// its history (it is still being uploaded).
  func clearHistory(olderThan cutoff: Date) {
    ensureLoaded()
    let busy = Set(pendingPoints.map(\.point.shiftId)).union(pendingMarks.map(\.mark.shiftId))
    for file in historyFiles() where file.modified < cutoff && !busy.contains(file.shiftId) {
      do {
        try FileManager.default.removeItem(at: file.url)
        recordedCounts[file.shiftId] = nil
        checkedTails.remove(file.url.path(percentEncoded: false))
        log("history of shift \(file.shiftId.prefix(8)) removed (last written \(file.modified))")
      } catch {
        log("could not remove history \(file.url.lastPathComponent): \(error.localizedDescription)")
      }
    }
  }

  // MARK: - Loading

  private func ensureLoaded() {
    guard !loaded else { return }
    loaded = true
    do {
      try FileManager.default.createDirectory(at: Self.historyDirectory(directory), withIntermediateDirectories: true)
    } catch {
      log("could not create \(directory.lastPathComponent): \(error.localizedDescription)")
    }
    replayJournal()
    clearHistory(olderThan: Date().addingTimeInterval(-retention))
  }

  private func replayJournal() {
    var points: [Int: TrackPoint] = [:]
    var marks: [Int: TrackMark] = [:]
    var maxSeq = 0
    var count = 0
    for line in readLines(journalURL) {
      count += 1
      switch line.op {
      case "seq":
        if let next = line.seq { maxSeq = max(maxSeq, next - 1) }
      case "p":
        guard let seq = line.seq, let shift = line.shift, let fix = line.fix else { continue }
        maxSeq = max(maxSeq, seq)
        points[seq] = TrackPoint(shiftId: shift, fix: fix)
      case "m":
        guard let seq = line.seq, let shift = line.shift, let kind = line.kind, let t = line.t else { continue }
        maxSeq = max(maxSeq, seq)
        marks[seq] = TrackMark(shiftId: shift, kind: kind, t: t)
      case "ack":
        for seq in line.seqs ?? [] {
          points[seq] = nil
          marks[seq] = nil
        }
      default:
        continue
      }
    }
    pendingPoints = points.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    pendingMarks = marks.sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    nextSeq = maxSeq + 1
    journalLines = count
    if !pendingPoints.isEmpty || !pendingMarks.isEmpty {
      log("restored \(pendingPoints.count) pending point(s), \(pendingMarks.count) mark(s)")
    }
    enforceCapacity()
    compactIfNeeded()
  }

  /// Decodes every complete line; a torn or corrupt line (crash mid-write) is skipped.
  private func readLines(_ url: URL) -> [Line] {
    guard let data = try? Data(contentsOf: url), !data.isEmpty else { return [] }
    var lines: [Line] = []
    var skipped = 0
    for slice in data.split(separator: 0x0A, omittingEmptySubsequences: true) {
      if let line = try? decoder.decode(Line.self, from: Data(slice)) {
        lines.append(line)
      } else {
        skipped += 1
      }
    }
    if skipped > 0 { log("skipped \(skipped) unreadable line(s) in \(url.lastPathComponent)") }
    return lines
  }

  private func historyFiles() -> [(shiftId: String, url: URL, modified: Date)] {
    let dir = Self.historyDirectory(directory)
    guard let urls = try? FileManager.default.contentsOfDirectory(
      at: dir, includingPropertiesForKeys: [.contentModificationDateKey], options: [.skipsHiddenFiles]
    ) else { return [] }
    return urls.compactMap { url in
      guard url.pathExtension == "jsonl" else { return nil }
      let name = url.deletingPathExtension().lastPathComponent
      guard let shiftId = name.removingPercentEncoding, !shiftId.isEmpty else { return nil }
      let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
      return (shiftId, url, modified)
    }
  }

  // MARK: - Writing

  private func takeSeq() -> Int {
    defer { nextSeq += 1 }
    return nextSeq
  }

  private func appendJournal(_ lines: [Line]) {
    appendLines(lines, to: journalURL)
    journalLines += lines.count
  }

  /// Appends newline-terminated JSON lines. The first append to a file in this process makes sure
  /// a line torn by a crash is terminated first, so it cannot swallow the new record.
  private func appendLines(_ lines: [Line], to url: URL) {
    var data = Data()
    for line in lines {
      guard let encoded = try? encoder.encode(line) else { continue }
      data.append(encoded)
      data.append(0x0A)
    }
    guard !data.isEmpty else { return }
    let path = url.path(percentEncoded: false)
    let fm = FileManager.default
    do {
      if !fm.fileExists(atPath: path) {
        try fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        guard fm.createFile(atPath: path, contents: nil, attributes: Self.fileAttributes) else { throw CocoaError(.fileWriteUnknown) }
      }
      let handle = try FileHandle(forUpdating: url)
      defer { try? handle.close() }
      let end = try handle.seekToEnd()
      if end > 0, !checkedTails.contains(path) {
        try handle.seek(toOffset: end - 1)
        if try handle.read(upToCount: 1) != Data([0x0A]) { data.insert(0x0A, at: 0) }
        _ = try handle.seekToEnd()
      }
      try handle.write(contentsOf: data)
      checkedTails.insert(path)
    } catch {
      checkedTails.remove(path)
      log("append to \(url.lastPathComponent) failed: \(error.localizedDescription)")
    }
  }

  /// Past `capacity` pending points, the oldest are dropped from the upload set (history keeps them).
  private func enforceCapacity() {
    let overflow = pendingPoints.count - capacity
    guard overflow > 0 else { return }
    let dropped = pendingPoints.prefix(overflow).map(\.seq)
    pendingPoints.removeFirst(overflow)
    appendJournal([Line(op: "ack", seqs: dropped)])
    if droppedSinceLog == 0 {
      log("pending track over capacity \(capacity); dropping oldest point(s) (logged every 500)")
    }
    droppedSinceLog += overflow
    if droppedSinceLog >= 500 {
      log("dropped \(droppedSinceLog) oldest pending point(s) for capacity")
      droppedSinceLog = 0
    }
    compactIfNeeded()
  }

  /// Rewrites the journal with only what is pending once it is mostly acknowledged lines.
  private func compactIfNeeded() {
    let live = pendingPoints.count + pendingMarks.count
    guard journalLines > 1, live == 0 || journalLines > 2 * live + 1_000 else { return }
    var lines = [Line(op: "seq", seq: nextSeq)]
    let items: [(Int, Line)] =
      pendingPoints.map { ($0.seq, Line(op: "p", seq: $0.seq, shift: $0.point.shiftId, fix: $0.point.fix)) } +
      pendingMarks.map { ($0.seq, Line(op: "m", seq: $0.seq, shift: $0.mark.shiftId, kind: $0.mark.kind, t: $0.mark.t)) }
    lines += items.sorted { $0.0 < $1.0 }.map(\.1)
    var data = Data()
    for line in lines {
      guard let encoded = try? encoder.encode(line) else { continue }
      data.append(encoded)
      data.append(0x0A)
    }
    do {
      try data.write(to: journalURL, options: Self.atomicWrite)
      journalLines = lines.count
      checkedTails.insert(journalURL.path(percentEncoded: false))
    } catch {
      log("journal compaction failed: \(error.localizedDescription)")
    }
  }

  // The phone records while locked in a pocket: files must stay writable after first unlock even if
  // the app later gains a stricter default data-protection entitlement.
  #if os(iOS)
  private static var fileAttributes: [FileAttributeKey: Any]? { [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication] }
  private static let atomicWrite: Data.WritingOptions = [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
  #else
  private static var fileAttributes: [FileAttributeKey: Any]? { nil }
  private static let atomicWrite: Data.WritingOptions = [.atomic]
  #endif

  private static func isPlausible(_ fix: LocationFix) -> Bool {
    fix.lat.isFinite && fix.lon.isFinite && abs(fix.lat) <= 90 && abs(fix.lon) <= 180
      && fix.accuracyM.isFinite && fix.accuracyM >= 0
  }
}
