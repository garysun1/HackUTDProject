//
// TrackJSONText.swift
// Shift Memory
//
// Hand-written JSON text for the contract payloads (event `location`, `ingest_track`, GeoJSON):
// fixed key order, numbers always as plain decimals (JSONSerialization writes 1e-05 for small values),
// non-finite numbers as null, and exact Bool/Int/Double handling on Darwin. Shared by EventEnvelope
// (Upload) and the track pipeline (Location).
//

import CoreFoundation
import Foundation

// MARK: - JSON text

/// Small JSON writer shared by the track body and the GeoJSON export: shortest round-trip number
/// text (`32.7767`, not `32.776699999999998`), non-finite numbers as `null`, unescaped slashes.
enum TrackJSONText {
  indirect enum Value: Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([Value])
    case object([String: Value])
  }

  static func string(_ s: String) -> String {
    guard let data = try? JSONSerialization.data(withJSONObject: [s], options: [.withoutEscapingSlashes]) else { return "\"\"" }
    return String(String(decoding: data, as: UTF8.self).dropFirst().dropLast())
  }

  /// Shortest round-trip decimal text, never in exponent notation (`0.00001`, not `1e-05`), and
  /// `null` for NaN / infinity, which JSON cannot carry.
  static func number(_ d: Double) -> String {
    guard d.isFinite else { return "null" }
    if d == d.rounded(.towardZero), abs(d) < 9e15 { return String(Int64(d)) }
    let text = "\(d)"
    guard let e = text.firstIndex(where: { $0 == "e" || $0 == "E" }), let exponent = Int(text[text.index(after: e)...]) else {
      return text
    }
    // Swift writes magnitudes below 1e-4 and from 2^53 up as `m.mmmme±x`; move the point by hand.
    var mantissa = text[..<e]
    let negative = mantissa.hasPrefix("-")
    if negative { mantissa = mantissa.dropFirst() }
    let intDigits = mantissa.firstIndex(of: ".").map { mantissa.distance(from: mantissa.startIndex, to: $0) } ?? mantissa.count
    let digits = Array(mantissa.filter { $0 != "." })
    let point = intDigits + exponent
    var out: String
    if point <= 0 {
      out = "0." + String(repeating: "0", count: -point) + String(digits)
    } else if point >= digits.count {
      out = String(digits) + String(repeating: "0", count: point - digits.count)
    } else {
      out = String(digits[..<point]) + "." + String(digits[point...])
    }
    if out.contains(".") {
      while out.hasSuffix("0") { out.removeLast() }
      if out.hasSuffix(".") { out.removeLast() }
    }
    while out.count > 1, out.hasPrefix("0"), !out.hasPrefix("0.") { out.removeFirst() }
    return negative ? "-" + out : out
  }

  /// A flat object from `contractObject`-style values with keys in `order` first, any others sorted after.
  static func object(_ object: [String: Any], order: [String]) -> String {
    let keys = order.filter { object[$0] != nil } + object.keys.filter { !order.contains($0) }.sorted()
    return "{" + keys.map { "\(string($0)):\(fragment(object[$0]!))" }.joined(separator: ",") + "}"
  }

  static func fragment(_ value: Any) -> String {
    // Exact native types first: on Darwin an NSNumber 1 also casts to Bool, and a Bool to Int.
    switch value {
    case let s as String: return string(s)
    case let b as Bool where type(of: value) == Bool.self: return b ? "true" : "false"
    case let i as Int where type(of: value) == Int.self: return String(i)
    case let d as Double where type(of: value) == Double.self: return number(d)
    case let n as NSNumber:
      if CFGetTypeID(n) == CFBooleanGetTypeID() { return n.boolValue ? "true" : "false" }
      return number(n.doubleValue)
    default: return "null"
    }
  }

  /// Pretty-printed (two-space indent) with sorted keys.
  static func pretty(_ value: Value, indent: String = "") -> String {
    let inner = indent + "  "
    switch value {
    case .null: return "null"
    case .bool(let b): return b ? "true" : "false"
    case .number(let d): return number(d)
    case .string(let s): return string(s)
    case .array(let items):
      if items.isEmpty { return "[]" }
      // Positions stay on one line: [lon, lat].
      if items.allSatisfy({ if case .number = $0 { true } else { false } }) {
        return "[" + items.map { pretty($0) }.joined(separator: ", ") + "]"
      }
      return "[\n" + items.map { inner + pretty($0, indent: inner) }.joined(separator: ",\n") + "\n" + indent + "]"
    case .object(let fields):
      if fields.isEmpty { return "{}" }
      return "{\n" + fields.keys.sorted().map { key in
        inner + string(key) + ": " + pretty(fields[key]!, indent: inner)
      }.joined(separator: ",\n") + "\n" + indent + "}"
    }
  }
}
