//
// FloorModels.swift
// Shift Memory
//
// One read of the shared memory that the phone needs to orient a wearer: the asset registry (with
// where each asset physically is), the alert table (the floor's open problems, "issues" in the UI),
// recent events with their summaries and wearer notes, state changes, and who wore which device.
// Everything comes from the module's public tables over the HTTP SQL endpoint, read-only; the only
// write is `ack_alert` when a wearer marks an issue resolved with a photo as evidence.
//
// Geography: `asset.location` is free text from Gary's registry CSV ("Row 1 / Rack R12", "Row 1",
// "Row 1 end", "Electrical room"). `FloorGeometry.place(_:)` turns it into a row index and a slot
// along that row, so the floor map can draw rows of racks and put each problem where it is. Assets
// whose location has no row land in a named side zone.
//

import Foundation

struct FloorAsset: Identifiable, Hashable, Sendable {
  let id: String            // asset_id, e.g. "PDU-A"
  let name: String          // "PDU A (Rack R12)"
  let type: String          // asset_type
  let location: String      // raw registry text
  let place: FloorPlace
}

/// Where an asset sits: a row (0-based order of appearance, labelled) and a rack within it, or a named zone.
struct FloorPlace: Hashable, Sendable {
  var row: String?          // "Row 1"
  var rack: String?         // "R12"
  var zone: String?         // "Electrical room" when there is no row
  var isRowEnd: Bool = false
}

/// An open or resolved problem on the floor. Today these are the module's `alert` rows (raised by
/// perception from fault text, OK→FAULT changes, or anomalies); a seeded work-order table would map
/// onto the same shape (see FLOOR_ISSUES.md).
struct FloorIssue: Identifiable, Hashable, Sendable {
  let id: UInt64            // alert_id
  let eventId: String       // the photo that raised it
  let at: Date
  let kind: String          // fault_text | state_change | anomaly
  let text: String
  let entityId: String
  let entityName: String
  let wearerName: String
  let deviceId: String
  let isResolved: Bool      // acked
  let resolvedAt: Date?
}

struct FloorEvent: Identifiable, Hashable, Sendable {
  let id: String
  let deviceId: String
  let at: Date              // server receive time
  let clientT: String
  let source: String
  let status: String
  let summary: String
  let note: String?
  let label: String?
  let location: String
}

struct FloorChange: Hashable, Sendable {
  let eventId: String
  let entityId: String
  let attr: String
  let from: String
  let to: String
}

struct FloorWearer: Hashable, Sendable {
  let deviceId: String
  let name: String
  let role: String
  let shift: String
}

struct FloorSnapshot: Sendable {
  var fetchedAt: Date
  var assets: [FloorAsset]
  var issues: [FloorIssue]
  var events: [FloorEvent]          // newest first
  var changes: [FloorChange]
  var wearers: [String: FloorWearer] // by device_id
  /// event_id → asset entity ids it involves (INVOLVES edges whose target is an asset entity).
  var involvesAsset: [String: Set<String>]
  /// Asset entity id (lowercased slug, e.g. "pdu_a") → registry asset, when they can be matched.
  var assetForEntity: [String: FloorAsset]

  static let empty = FloorSnapshot(fetchedAt: .distantPast, assets: [], issues: [], events: [], changes: [],
                                   wearers: [:], involvesAsset: [:], assetForEntity: [:])

  var openIssues: [FloorIssue] { issues.filter { !$0.isResolved }.sorted { $0.at > $1.at } }

  func wearerName(_ deviceId: String) -> String {
    wearers[deviceId]?.name.nilIfEmpty ?? deviceId
  }

  func asset(forIssue issue: FloorIssue) -> FloorAsset? {
    assetForEntity[issue.entityId] ?? FloorGeometry.match(name: issue.entityName, in: assets)
  }

  /// Events that touched an asset, newest first.
  func events(for asset: FloorAsset) -> [FloorEvent] {
    let entityIds = Set(assetForEntity.filter { $0.value.id == asset.id }.map(\.key))
    return events.filter { e in
      !(involvesAsset[e.id] ?? []).isDisjoint(with: entityIds)
        || (e.label.map { FloorGeometry.match(name: $0, in: [asset]) != nil } ?? false)
    }
  }
}

enum FloorGeometry {
  /// "Row 1 / Rack R12" → row "Row 1", rack "R12"; "Row 1 end" → row "Row 1", end; "UPS room" → zone.
  static func place(_ location: String) -> FloorPlace {
    let text = location.trimmingCharacters(in: .whitespaces)
    var place = FloorPlace()
    let parts = text.split(separator: "/").map { $0.trimmingCharacters(in: .whitespaces) }
    for part in parts {
      let lower = part.lowercased()
      if lower.hasPrefix("row") {
        let tokens = part.split(separator: " ")
        if tokens.count >= 2 { place.row = "Row \(tokens[1])" } else { place.row = part }
        if lower.hasSuffix(" end") { place.isRowEnd = true }
      } else if lower.hasPrefix("rack") {
        let tokens = part.split(separator: " ")
        place.rack = tokens.count >= 2 ? String(tokens[1]) : part
      }
    }
    if place.row == nil && place.rack == nil { place.zone = text.isEmpty ? "Unplaced" : text }
    return place
  }

  /// Loose name match between perception's entity text / a wearer label and the registry.
  static func match(name: String, in assets: [FloorAsset]) -> FloorAsset? {
    let n = normalize(name)
    guard !n.isEmpty else { return nil }
    if let exact = assets.first(where: { normalize($0.id) == n || normalize($0.name) == n }) { return exact }
    return assets.first(where: { a in
      let an = normalize(a.name)
      return an.hasPrefix(n) || n.hasPrefix(normalize(a.id)) || an.contains(n)
    })
  }

  static func normalize(_ s: String) -> String {
    s.lowercased().filter { $0.isLetter || $0.isNumber }
  }

  /// Rows in display order ("Row 1", "Row 2", …) with their racks left to right, then side zones.
  static func layout(_ assets: [FloorAsset]) -> (rows: [(row: String, racks: [String])], zones: [String]) {
    var rows: [String: Set<String>] = [:]
    var zones: Set<String> = []
    for a in assets {
      if let row = a.place.row {
        var racks = rows[row] ?? []
        if let rack = a.place.rack { racks.insert(rack) }
        rows[row] = racks
      } else if let zone = a.place.zone {
        zones.insert(zone)
      }
    }
    let sortedRows = rows.keys.sorted { $0.localizedStandardCompare($1) == .orderedAscending }
      .map { (row: $0, racks: rows[$0]!.sorted { $0.localizedStandardCompare($1) == .orderedAscending }) }
    return (sortedRows, zones.sorted())
  }
}

extension String {
  var nilIfEmpty: String? { isEmpty ? nil : self }
}

// MARK: - Repository

/// Reads the snapshot (one SQL statement per table) and performs `ack_alert`.
final class FloorRepository: Sendable {
  private let client: IngestClient
  /// How far back events are read; the briefing narrows further.
  private let eventWindow: TimeInterval

  init(client: IngestClient, eventWindow: TimeInterval = 36 * 3600) {
    self.client = client
    self.eventWindow = eventWindow
  }

  func fetch(now: Date = Date()) async throws(IngestError) -> FloorSnapshot {
    let sinceMicros = UInt64(max(0, now.addingTimeInterval(-eventWindow).timeIntervalSince1970) * 1_000_000)
    async let assetRows = client.sql("SELECT asset_id, name, asset_type, location FROM asset")
    async let alertRows = client.sql("SELECT alert_id, event_id, t_micros, kind, text, entity_id, entity_name, device_id, wearer_name, acked, acked_micros FROM alert")
    async let eventRows = client.sql("SELECT event_id, device_id, t_micros, client_t, source, status, summary, note, label, location_guess FROM event WHERE t_micros > \(sinceMicros)")
    async let edgeRows = client.sql("SELECT from_id, to_id, kind, props FROM edge WHERE kind = 'CHANGES' OR kind = 'INVOLVES'")
    async let entityRows = client.sql("SELECT entity_id, canonical_name, kind FROM entity WHERE kind = 'asset'")
    async let wearerRows = client.sql("SELECT device_id, name, role, shift FROM wearer")

    let assets: [FloorAsset]
    let issues: [FloorIssue]
    let events: [FloorEvent]
    let edges: [[SQLValue]]
    let entities: [[SQLValue]]
    let wearersRaw: [[SQLValue]]
    do {
      assets = try await assetRows.map { r in
        let loc = r[safe: 3]?.string ?? ""
        return FloorAsset(id: r[safe: 0]?.string ?? "", name: r[safe: 1]?.string ?? "", type: r[safe: 2]?.string ?? "",
                          location: loc, place: FloorGeometry.place(loc))
      }
      issues = try await alertRows.map { r in
        FloorIssue(
          id: r[safe: 0]?.uint64 ?? 0, eventId: r[safe: 1]?.string ?? "",
          at: Date(micros: r[safe: 2]?.uint64 ?? 0), kind: r[safe: 3]?.string ?? "", text: r[safe: 4]?.string ?? "",
          entityId: r[safe: 5]?.string ?? "", entityName: r[safe: 6]?.string ?? "", wearerName: r[safe: 8]?.string ?? "",
          deviceId: r[safe: 7]?.string ?? "", isResolved: r[safe: 9]?.bool ?? false,
          resolvedAt: r[safe: 10]?.uint64.map { Date(micros: $0) })
      }
      events = try await eventRows.map { r in
        FloorEvent(
          id: r[safe: 0]?.string ?? "", deviceId: r[safe: 1]?.string ?? "", at: Date(micros: r[safe: 2]?.uint64 ?? 0),
          clientT: r[safe: 3]?.string ?? "", source: r[safe: 4]?.string ?? "", status: r[safe: 5]?.string ?? "",
          summary: r[safe: 6]?.string ?? "", note: r[safe: 7]?.string?.nilIfEmpty, label: r[safe: 8]?.string?.nilIfEmpty,
          location: r[safe: 9]?.string ?? "")
      }.sorted { $0.at > $1.at }
      edges = try await edgeRows
      entities = try await entityRows
      wearersRaw = try await wearerRows
    } catch let error as IngestError {
      throw error
    } catch {
      throw .decoding(String(describing: error))
    }

    var changes: [FloorChange] = []
    var involves: [String: Set<String>] = [:]
    for r in edges {
      let from = r[safe: 0]?.string ?? "", to = r[safe: 1]?.string ?? "", kind = r[safe: 2]?.string ?? ""
      let props = (r[safe: 3]?.string).flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] } ?? [:]
      if kind == "CHANGES" {
        changes.append(FloorChange(eventId: from, entityId: to, attr: props["attr"] as? String ?? "",
                                   from: props["from"] as? String ?? "", to: props["to"] as? String ?? ""))
      } else if kind == "INVOLVES" {
        involves[from, default: []].insert(to)
      }
    }
    var assetForEntity: [String: FloorAsset] = [:]
    for r in entities {
      let id = r[safe: 0]?.string ?? "", name = r[safe: 1]?.string ?? ""
      if let a = FloorGeometry.match(name: name, in: assets) ?? FloorGeometry.match(name: id, in: assets) {
        assetForEntity[id] = a
      }
    }
    // Keep only asset entities in `involves` so the map is not cluttered by places and objects.
    involves = involves.mapValues { $0.filter { assetForEntity[$0] != nil } }.filter { !$0.value.isEmpty }
    var wearers: [String: FloorWearer] = [:]
    for r in wearersRaw {
      let w = FloorWearer(deviceId: r[safe: 0]?.string ?? "", name: r[safe: 1]?.string ?? "",
                          role: r[safe: 2]?.string ?? "", shift: r[safe: 3]?.string ?? "")
      wearers[w.deviceId] = w
    }
    return FloorSnapshot(fetchedAt: now, assets: assets, issues: issues, events: events, changes: changes,
                         wearers: wearers, involvesAsset: involves, assetForEntity: assetForEntity)
  }

  func resolve(_ issue: FloorIssue) async throws(IngestError) {
    try await client.ackAlert(alertId: issue.id)
  }
}

extension Date {
  init(micros: UInt64) { self.init(timeIntervalSince1970: TimeInterval(micros) / 1_000_000) }
}

extension Array {
  subscript(safe index: Int) -> Element? { indices.contains(index) ? self[index] : nil }
}
