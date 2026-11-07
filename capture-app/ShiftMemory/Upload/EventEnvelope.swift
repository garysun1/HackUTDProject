//
// EventEnvelope.swift
// Shift Memory
//
// Builds the exact `event_json` string that `ingest_photo(event_json, photo_b64)` expects.
// Keys and shapes are docs/CONTRACT.md v3; the module ignores unknown keys and reads
// `label.name`, `photo.mime/width/height`, `clock_offset_ms`, `note`, `wearer`.
//

import Foundation

enum EventEnvelope {
  static let appVersion: String = {
    (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.1.0"
  }()

  /// ISO-8601 with milliseconds and the phone's UTC offset, e.g. `2026-11-08T14:41:03.120-06:00`.
  static func iso8601(_ date: Date, offsetSeconds: Int) -> String {
    let f = DateFormatter()
    f.locale = Locale(identifier: "en_US_POSIX")
    f.timeZone = TimeZone(secondsFromGMT: offsetSeconds) ?? .current
    f.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSSXXXXX"
    return f.string(from: date)
  }

  /// The `event_json` argument. Nulls are written explicitly for `note` and `label`, as in the
  /// contract's example. Key order is fixed so the payload diffs cleanly in logs.
  static func json(for event: CaptureEvent, ingestToken: String, appVersion: String = appVersion) -> String {
    var o: [(String, Any)] = []
    o.append(("event_id", event.id))
    o.append(("device_id", event.deviceId))
    o.append(("client_t", iso8601(event.clientT, offsetSeconds: event.clientTZOffsetSeconds)))
    o.append(("source", event.source.rawValue))
    o.append(("photo", ["mime": "image/jpeg", "width": event.width, "height": event.height] as [String: Any]))
    o.append(("note", event.note.flatMap { $0.isEmpty ? nil : $0 } ?? NSNull()))
    o.append(("label", event.label.flatMap { $0.isEmpty ? nil : ["name": $0] } ?? NSNull()))
    o.append(("clock_offset_ms", event.clockOffsetMs ?? 0))
    if let wearer = event.wearer, !wearer.isEmpty { o.append(("wearer", wearer)) }
    o.append(("ingest_token", ingestToken))
    o.append(("app_version", appVersion))
    return serialize(o)
  }

  // JSONSerialization does not preserve key order; write the top level by hand, values via JSONSerialization.
  private static func serialize(_ pairs: [(String, Any)]) -> String {
    let parts = pairs.map { key, value -> String in
      "\"\(key)\":\(fragment(value))"
    }
    return "{" + parts.joined(separator: ",") + "}"
  }

  private static func fragment(_ value: Any) -> String {
    switch value {
    case is NSNull: return "null"
    case let s as String:
      let data = try! JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes])
      let wrapped = String(decoding: data, as: UTF8.self)
      return String(wrapped.dropFirst().dropLast())
    case let n as Int: return String(n)
    case let b as Bool: return b ? "true" : "false"
    default:
      let data = try! JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .withoutEscapingSlashes])
      return String(decoding: data, as: UTF8.self)
    }
  }
}
