//
// LocationFix.swift
// Shift Memory
//
// One position from the iPhone (Core Location, WGS84), as carried on an event (`event_json.location`)
// and as a point of the shift track (`ingest_track`), contract v3.1 (issues #19, #20). Plain values
// only, so it is Codable for the on-disk upload queue and track buffer and Sendable across actors.
//

import CoreLocation
import Foundation

struct LocationFix: Codable, Sendable, Hashable {
  var lat: Double
  var lon: Double
  /// Horizontal accuracy radius in metres (Core Location's 68% confidence).
  var accuracyM: Double
  var altM: Double?
  var altAccuracyM: Double?
  /// Indoor floor level when the venue publishes one (`CLFloor.level`).
  var floor: Int?
  var speedMps: Double?
  var courseDeg: Double?
  /// When the fix was taken.
  var t: Date

  /// Fixes worse than this are not attached to events (contract: omit when worse than 100 m).
  static let maxEventAccuracyM: Double = 100
  /// Fixes older than this at capture time are not attached (contract: 120 s).
  static let maxEventAge: TimeInterval = 120

  init(lat: Double, lon: Double, accuracyM: Double, altM: Double? = nil, altAccuracyM: Double? = nil,
       floor: Int? = nil, speedMps: Double? = nil, courseDeg: Double? = nil, t: Date) {
    self.lat = lat
    self.lon = lon
    self.accuracyM = accuracyM
    self.altM = altM
    self.altAccuracyM = altAccuracyM
    self.floor = floor
    self.speedMps = speedMps
    self.courseDeg = courseDeg
    self.t = t
  }

  /// From a Core Location fix; nil when it is not a usable position (negative accuracy = invalid).
  init?(_ location: CLLocation) {
    guard location.horizontalAccuracy >= 0,
          CLLocationCoordinate2DIsValid(location.coordinate),
          !(location.coordinate.latitude == 0 && location.coordinate.longitude == 0)
    else { return nil }
    self.lat = location.coordinate.latitude
    self.lon = location.coordinate.longitude
    self.accuracyM = location.horizontalAccuracy
    // Core Location marks an invalid altitude / speed / course with a negative accuracy or value.
    if location.verticalAccuracy > 0 {
      self.altM = location.altitude
      self.altAccuracyM = location.verticalAccuracy
    } else {
      self.altM = nil
      self.altAccuracyM = nil
    }
    self.floor = location.floor?.level
    self.speedMps = location.speed >= 0 && location.speedAccuracy >= 0 ? location.speed : nil
    self.courseDeg = location.course >= 0 && location.courseAccuracy >= 0 ? location.course : nil
    self.t = location.timestamp
  }

  /// Whether this fix may be attached to an event captured at `capturedAt` (contract v3.1).
  func isUsableForEvent(capturedAt: Date) -> Bool {
    accuracyM <= Self.maxEventAccuracyM && abs(capturedAt.timeIntervalSince(t)) <= Self.maxEventAge
  }

  /// Great-circle distance in metres.
  func distance(to other: LocationFix) -> Double {
    CLLocation(latitude: lat, longitude: lon).distance(from: CLLocation(latitude: other.lat, longitude: other.lon))
  }

  /// The contract's JSON object. Coordinates rounded to 7 decimals (~1 cm), metres to 0.1.
  /// `ageMs` is set for event locations (fix age at capture time), omitted for track points.
  func contractObject(offsetSeconds: Int, ageMs: Int? = nil) -> [String: Any] {
    var o: [String: Any] = [
      "lat": Self.round(lat, 7),
      "lon": Self.round(lon, 7),
      "accuracy_m": Self.round(accuracyM, 1),
      "t": EventEnvelope.iso8601(t, offsetSeconds: offsetSeconds),
    ]
    if let altM { o["alt_m"] = Self.round(altM, 1) }
    if let altAccuracyM { o["alt_accuracy_m"] = Self.round(altAccuracyM, 1) }
    if let floor { o["floor"] = floor }
    if let speedMps { o["speed_mps"] = Self.round(speedMps, 2) }
    // 359.96 rounds to 360.0; the course range is [0, 360).
    if let courseDeg { o["course_deg"] = Self.round(courseDeg, 1).truncatingRemainder(dividingBy: 360) }
    if let ageMs { o["age_ms"] = ageMs }
    return o
  }

  /// Key order of `contractObject` when written as JSON (issue #20 lists them in this order).
  static let contractKeyOrder = ["lat", "lon", "accuracy_m", "alt_m", "alt_accuracy_m", "floor", "speed_mps", "course_deg", "t", "age_ms"]

  static func round(_ value: Double, _ places: Int) -> Double {
    let p = pow(10.0, Double(places))
    return (value * p).rounded() / p
  }
}
