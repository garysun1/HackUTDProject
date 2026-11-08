//
// ShiftGeoJSON.swift
// Shift Memory
//
// Exports one shift as an RFC 7946 GeoJSON FeatureCollection: the wearer's walk as a LineString,
// a Point per photo that carried a location, and a Point per shift start/end mark (placed at the
// track point nearest in time; marks carry no position of their own). Coordinates are
// [longitude, latitude] WGS84 without altitude. Times are ISO-8601 with the phone's UTC offset.
// Hand-written JSON so coordinates print as 32.7767123 rather than JSONSerialization's
// 32.776712299999998, pretty-printed with sorted keys so exports diff cleanly.
//

import Foundation

struct PhotoPin: Sendable {
  let eventId: String
  let t: Date
  let fix: LocationFix
  let source: String
  let note: String?
  let summary: String?
}

enum ShiftGeoJSON {
  static func featureCollection(
    shiftId: String,
    deviceId: String,
    wearer: String?,
    points: [TrackPoint],
    marks: [TrackMark],
    photos: [PhotoPin],
    timeZone: TimeZone = .current
  ) -> Data {
    func time(_ date: Date) -> TrackJSONText.Value {
      .string(EventEnvelope.iso8601(date, offsetSeconds: timeZone.secondsFromGMT(for: date)))
    }
    func optional(_ s: String?) -> TrackJSONText.Value { s.map { .string($0) } ?? .null }

    let track = points
      .filter { isValid($0.fix) }
      .enumerated()
      .sorted { ($0.element.fix.t, $0.offset) < ($1.element.fix.t, $1.offset) }
      .map(\.element.fix)
    var features: [TrackJSONText.Value] = []

    if let first = track.first, let last = track.last {
      var distance = 0.0
      for (a, b) in zip(track, track.dropFirst()) { distance += a.distance(to: b) }
      let geometry: TrackJSONText.Value = track.count >= 2
        ? .object(["type": .string("LineString"), "coordinates": .array(track.map(position))])
        : .object(["type": .string("Point"), "coordinates": position(first)])
      features.append(feature(geometry: geometry, properties: [
        "kind": .string("track"),
        "shift_id": .string(shiftId),
        "device_id": .string(deviceId),
        "wearer": optional(wearer.flatMap { $0.isEmpty ? nil : $0 }),
        "start": time(first.t),
        "end": time(last.t),
        "point_count": .number(Double(track.count)),
        "distance_m": .number(LocationFix.round(distance, 1)),
      ]))

      for mark in marks.sorted(by: { $0.t < $1.t }) {
        guard let nearest = track.min(by: { abs($0.t.timeIntervalSince(mark.t)) < abs($1.t.timeIntervalSince(mark.t)) })
        else { continue }
        features.append(feature(geometry: .object(["type": .string("Point"), "coordinates": position(nearest)]), properties: [
          "kind": .string(mark.kind),
          "shift_id": .string(shiftId),
          "t": time(mark.t),
        ]))
      }
    }

    for photo in photos.sorted(by: { $0.t < $1.t }) where isValid(photo.fix) {
      features.append(feature(geometry: .object(["type": .string("Point"), "coordinates": position(photo.fix)]), properties: [
        "kind": .string("photo"),
        "event_id": .string(photo.eventId),
        "t": time(photo.t),
        "source": .string(photo.source),
        "note": optional(photo.note),
        "summary": optional(photo.summary),
        "accuracy_m": .number(LocationFix.round(photo.fix.accuracyM, 1)),
      ]))
    }

    let collection: TrackJSONText.Value = .object(["type": .string("FeatureCollection"), "features": .array(features)])
    return Data((TrackJSONText.pretty(collection) + "\n").utf8)
  }

  private static func feature(geometry: TrackJSONText.Value, properties: [String: TrackJSONText.Value]) -> TrackJSONText.Value {
    .object(["type": .string("Feature"), "geometry": geometry, "properties": .object(properties)])
  }

  /// RFC 7946 position: [longitude, latitude].
  private static func position(_ fix: LocationFix) -> TrackJSONText.Value {
    .array([.number(LocationFix.round(fix.lon, 7)), .number(LocationFix.round(fix.lat, 7))])
  }

  private static func isValid(_ fix: LocationFix) -> Bool {
    fix.lat.isFinite && fix.lon.isFinite && abs(fix.lat) <= 90 && abs(fix.lon) <= 180
  }
}
