//
// SQLValue.swift
// Shift Memory
//
// One cell of a SpacetimeDB HTTP SQL reply. Strings and numbers arrive as JSON scalars; `option`
// columns arrive as a sum type, `{"some": v}` / `{"none": []}` (or the positional `[0, v]` /
// `[1, []]` form); timestamps as `{"__timestamp_micros_since_unix_epoch__": n}`. Accessors unwrap
// all of those so callers read `row[3]?.string` without caring which form came back.
//

import Foundation

struct SQLValue: @unchecked Sendable {
  let raw: Any

  init(_ raw: Any) { self.raw = raw }

  /// The value with any option/sum wrapper removed; nil for `none` and JSON null.
  var unwrapped: Any? {
    var v: Any = raw
    for _ in 0..<3 {
      if v is NSNull { return nil }
      if let d = v as? [String: Any], d.count == 1, let (k, inner) = d.first {
        if k == "none" { return nil }
        if k == "some" { v = inner; continue }
        if k == "__timestamp_micros_since_unix_epoch__" { v = inner; continue }
        return v
      }
      if let a = v as? [Any], a.count == 2, let tag = a[0] as? Int {
        if tag == 1, (a[1] as? [Any])?.isEmpty ?? false { return nil }   // none
        if tag == 0 { v = a[1]; continue }                               // some
      }
      return v
    }
    return v
  }

  var string: String? {
    switch unwrapped {
    case let s as String: s
    case let n as NSNumber: n.stringValue
    default: nil
    }
  }

  var uint64: UInt64? {
    switch unwrapped {
    case let n as NSNumber: n.uint64Value
    case let s as String: UInt64(s)
    default: nil
    }
  }

  var bool: Bool? {
    switch unwrapped {
    case let n as NSNumber: n.boolValue
    case let s as String: s == "true"
    default: nil
    }
  }
}
