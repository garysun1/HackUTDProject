//
// FloorSites.swift
// Shift Memory
//
// Where a wearer can change floors: the staircases and elevators of a site, used by `FloorFusion`
// to accept a barometric floor change only near one of them (issue #19). One list per site, keyed
// by a short site id, so another building is one more entry. Coordinates are WGS84 from OpenStreetMap.
//

import CoreLocation
import Foundation

struct FloorSite: Sendable, Hashable {
  enum Kind: String, Sendable, Codable {
    case stairs, elevator
  }

  let kind: Kind
  let lat: Double
  let lon: Double
  let name: String

  /// Great-circle distance from a fix, metres.
  func distance(to fix: LocationFix) -> Double {
    CLLocation(latitude: lat, longitude: lon).distance(from: CLLocation(latitude: fix.lat, longitude: fix.lon))
  }
}

enum FloorSites {
  /// ECSW (Engineering and Computer Science West), UT Dallas — the HackUTD venue.
  static let ecsw: [FloorSite] = [
    FloorSite(kind: .stairs, lat: 32.9862522, lon: -96.7512867, name: "east stairs north"),
    FloorSite(kind: .stairs, lat: 32.9859497, lon: -96.7512871, name: "east stairs south"),
    FloorSite(kind: .stairs, lat: 32.9859495, lon: -96.7519811, name: "west stairs"),
    FloorSite(kind: .elevator, lat: 32.9859848, lon: -96.7512798, name: "east elevator south"),
    FloorSite(kind: .elevator, lat: 32.9862521, lon: -96.7512785, name: "east elevator north"),
    FloorSite(kind: .elevator, lat: 32.9862481, lon: -96.7519722, name: "west elevator"),
  ]

  /// Sites by id. The demo runs at ECSW; add a building here to use the app elsewhere.
  static let bySite: [String: [FloorSite]] = [
    "ecsw": ecsw,
  ]

  static let defaultSite = "ecsw"

  /// The closest stair or elevator to a fix, with its distance in metres; nil for an empty list.
  static func nearest(to fix: LocationFix, in sites: [FloorSite]) -> (site: FloorSite, distanceM: Double)? {
    sites.map { ($0, $0.distance(to: fix)) }.min { $0.1 < $1.1 }
  }
}
