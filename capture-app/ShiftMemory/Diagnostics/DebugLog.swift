//
// DebugLog.swift
// Shift Memory
//
// Append-only diagnostic log at Application Support/debug.log, pulled from the phone with
//   xcrun devicectl device copy from --device <udid> --domain-type appDataContainer \
//     --domain-identifier com.edwardkim.hackutd.shiftmemory \
//     --source "Library/Application Support/debug.log" --destination debug.log
// It exists because NSLog lines from this process reach `idevicesyslog` redacted as `<private>`
// on the iOS 26 test phone, which made the hardware runs (issue #10) unreadable from the Mac.
// Lines also go to NSLog for the Xcode console. Nothing here is uploaded.
//

import Foundation

enum DebugLog {
  private static let queue = DispatchQueue(label: "shiftmemory.debuglog", qos: .utility)
  private static let maxBytes = 4 * 1024 * 1024

  nonisolated static var url: URL {
    let support = (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))
      ?? FileManager.default.temporaryDirectory
    return support.appending(path: "debug.log")
  }

  /// `write("Glasses", "photo state -> started")` → `2026-11-08T00:41:02.123Z [Glasses] photo state -> started`.
  nonisolated static func write(_ tag: String, _ message: String) {
    NSLog("[%@] %@", tag, message)
    let stamp = Date().formatted(.iso8601.time(includingFractionalSeconds: true))
    let line = "\(stamp) [\(tag)] \(message)\n"
    queue.async { append(line) }
  }

  private static func append(_ line: String) {
    let url = url
    let fm = FileManager.default
    if let size = (try? fm.attributesOfItem(atPath: url.path(percentEncoded: false))[.size] as? Int), size > maxBytes {
      try? fm.removeItem(at: url.deletingPathExtension().appendingPathExtension("1.log"))
      try? fm.moveItem(at: url, to: url.deletingPathExtension().appendingPathExtension("1.log"))
    }
    if !fm.fileExists(atPath: url.path(percentEncoded: false)) {
      fm.createFile(atPath: url.path(percentEncoded: false), contents: nil)
    }
    guard let handle = try? FileHandle(forWritingTo: url) else { return }
    defer { try? handle.close() }
    _ = try? handle.seekToEnd()
    try? handle.write(contentsOf: Data(line.utf8))
  }
}
