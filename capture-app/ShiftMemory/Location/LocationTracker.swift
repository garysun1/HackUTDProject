//
// LocationTracker.swift
// Shift Memory
//
// The phone's position for the web console's map (contract v3.1, issues #19, #20). Two uses:
//   - foreground: a ~10 m fix while the app is open, so captured events carry `event_json.location`
//     (`freshFix(at:)`);
//   - shift: a continuous walking track of the wearer for the whole shift, phone locked in a pocket
//     included. Every fix goes through `TrackSampler` (>= 5 m or 30 s, accuracy <= 50 m) and each
//     kept point is handed to `onTrackPoint` for the track uploader.
//
// Built on CLLocationManager.startUpdatingLocation (iOS 17.2 deployment; no iOS 18 CLServiceSession).
// Background: with only When-In-Use authorization, updates continue after the app leaves the
// foreground ONLY when they were started while it was in front with allowsBackgroundLocationUpdates
// and the "location" UIBackgroundModes entry; iOS then shows the blue location pill. Always
// authorization is never requested here. Updates that stop (app killed, authorization revoked) are
// not resumed in the background.
//
// Threading: the manager is created in `init`, which is main-actor isolated, so Core Location
// delivers every delegate callback on the main run loop (it calls back on the run loop of the thread
// that created the manager). The nonisolated delegate methods first reduce what they receive to
// Sendable values (LocationFix, Authorization, error code), then run the handler with
// `MainActor.assumeIsolated` when on the main thread, or hop with a main-actor Task otherwise
// (defensive; not expected), so nothing non-Sendable crosses an isolation boundary.
//

import CoreLocation
import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class LocationTracker: NSObject {
  enum Authorization: Equatable, Sendable {
    case notDetermined, restricted, denied, whenInUse, always
  }

  enum Mode: Equatable, Sendable {
    /// Location off.
    case off
    /// App in front, no shift: fixes for tagging events.
    case foreground
    /// A shift is running: continuous track, background included.
    case shift
  }

  /// Fixes older than this when delivered (Core Location's cached fix on start) are not "latest".
  static let maxDeliveryAge: TimeInterval = 30
  /// One log line per this many kept track points.
  static let logEveryKeptPoints = 25

  // MARK: Observable state
  private(set) var authorization: Authorization
  /// Precise location granted (`accuracyAuthorization == .fullAccuracy`). With approximate location
  /// (~1–5 km), no fix passes the 100 m event rule or the 50 m track rule.
  private(set) var isPrecise: Bool
  /// Newest valid fix from any mode (no older than `maxDeliveryAge` when it arrived).
  private(set) var latest: LocationFix?
  /// The mode the app asked for. Updates actually run only while `authorization` is whenInUse or
  /// always; a mode requested earlier starts by itself once authorization is granted.
  private(set) var mode: Mode = .off
  /// A user-facing sentence, or nil.
  private(set) var lastError: String?
  /// Points accepted by the sampler this shift.
  private(set) var keptPoints = 0

  // MARK: Hooks (set by the composition root)
  /// Fired on the main actor for each sampler-accepted fix while `mode == .shift`.
  var onTrackPoint: ((LocationFix) -> Void)?
  /// The barometric floor relative to the shift start (AltimeterFloorTracker), asked for every
  /// fix. Used only when Core Location has no `CLFloor` for the fix (no indoor survey at ECSW).
  var barometricFloor: (() -> Int?)?

  // MARK: Private
  @ObservationIgnored private let manager: CLLocationManager
  @ObservationIgnored private let log: (String) -> Void
  @ObservationIgnored private var sampler: TrackSampler
  /// Whether `startUpdatingLocation` is in effect.
  @ObservationIgnored private var isUpdating = false
  /// Fixes taken before this are not track points (e.g. Core Location's cached fix on start).
  @ObservationIgnored private var shiftStartedAt: Date?
  /// Whether the first fix of the current start was logged.
  @ObservationIgnored private var loggedFirstFix = false

  init(log: @escaping (String) -> Void, sampler: TrackSampler = TrackSampler()) {
    let manager = CLLocationManager()
    self.manager = manager
    self.log = log
    self.sampler = sampler
    self.authorization = Self.map(manager.authorizationStatus)
    self.isPrecise = manager.accuracyAuthorization == .fullAccuracy
    super.init()
    // Created on the main thread (this init is main-actor isolated), so callbacks arrive there too.
    manager.delegate = self
  }

  // MARK: - Public

  /// Shows the When-In-Use prompt if the user has not answered yet. Never asks for Always.
  func requestAuthorization() {
    guard manager.authorizationStatus == .notDetermined else { return }
    log("requesting when-in-use authorization")
    manager.requestWhenInUseAuthorization()
  }

  /// App in front, no shift: ~10 m fixes for tagging events, no background updates.
  /// No-op while a shift is running (the shift's updates are a superset).
  func startForeground() {
    guard mode != .shift else { return }
    setMode(.foreground)
    apply()
  }

  /// Continuous tracking for the shift. Call while the app is in the foreground: with When-In-Use
  /// authorization iOS only lets updates continue in the background when they started in front.
  /// Resets the sampler and `keptPoints`.
  func startShift() {
    if UIApplication.shared.applicationState == .background {
      log("startShift while in background: with when-in-use authorization updates may not start until the app is opened")
    }
    sampler.reset()
    keptPoints = 0
    shiftStartedAt = Date()
    setMode(.shift)
    apply()
  }

  /// Ends the shift's track: back to `.foreground` when the app is in front, else `.off`.
  func stopShift() {
    guard mode == .shift else { return }
    shiftStartedAt = nil
    // `.inactive` (Control Center, an alert, app switcher) is still "in front" for tagging events.
    setMode(UIApplication.shared.applicationState != .background ? .foreground : .off)
    apply()
  }

  /// Everything off.
  func stop() {
    shiftStartedAt = nil
    setMode(.off)
    apply()
  }

  /// `latest` when it may be attached to an event captured at `date` (100 m, 120 s; contract v3.1).
  func freshFix(at date: Date = Date()) -> LocationFix? {
    guard let latest, latest.isUsableForEvent(capturedAt: date) else { return nil }
    return latest
  }

  // MARK: - Updates

  private func setMode(_ new: Mode) {
    guard new != mode else { return }
    log("mode \(mode) -> \(new)")
    mode = new
  }

  /// Brings the manager in line with `mode` and `authorization`.
  private func apply() {
    let authorized = authorization == .whenInUse || authorization == .always
    guard mode != .off, authorized else {
      if mode != .off, !authorized, manager.authorizationStatus == .notDetermined {
        requestAuthorization()
      }
      stopUpdates()
      return
    }
    switch mode {
    case .off:
      return
    case .foreground:
      manager.desiredAccuracy = kCLLocationAccuracyNearestTenMeters
      // No distance filter: a wearer standing still must still have a fix newer than 120 s when they
      // press the shutter (the contract drops older fixes). Accuracy stays at ~10 m to spare battery.
      manager.distanceFilter = kCLDistanceFilterNone
      manager.activityType = .other
      // An automatic pause is only undone by calling startUpdatingLocation again, so a paused
      // manager would silently leave `latest` to go stale while the app is open.
      manager.pausesLocationUpdatesAutomatically = false
      if manager.allowsBackgroundLocationUpdates { manager.allowsBackgroundLocationUpdates = false }
      manager.showsBackgroundLocationIndicator = false
    case .shift:
      manager.desiredAccuracy = kCLLocationAccuracyBest
      // The sampler decides what is kept; Core Location's filter would hide accuracy upgrades.
      manager.distanceFilter = kCLDistanceFilterNone
      // Header: "positioning indoors and outdoors that isn't tied to a dedicated fitness session,
      // e.g. walking" — a person walking a work site. `.fitness` is for workouts.
      manager.activityType = .otherNavigation
      // A wearer standing at a rack for minutes must not end the track.
      manager.pausesLocationUpdatesAutomatically = false
      if Self.hasLocationBackgroundMode {
        manager.allowsBackgroundLocationUpdates = true
      } else {
        // Setting it without the mode is a fatal error (CLLocationManager.h).
        log("UIBackgroundModes lacks \"location\": the track stops when the app leaves the foreground")
      }
      manager.showsBackgroundLocationIndicator = true
    }
    loggedFirstFix = false
    manager.startUpdatingLocation()
    if !isUpdating { log("updates started (\(mode))") }
    isUpdating = true
  }

  private func stopUpdates() {
    guard isUpdating else { return }
    manager.stopUpdatingLocation()
    if manager.allowsBackgroundLocationUpdates { manager.allowsBackgroundLocationUpdates = false }
    isUpdating = false
    log("updates stopped")
  }

  /// Whether Info.plist's UIBackgroundModes contains "location".
  nonisolated static var hasLocationBackgroundMode: Bool {
    (Bundle.main.object(forInfoDictionaryKey: "UIBackgroundModes") as? [String])?.contains("location") ?? false
  }

  nonisolated static func map(_ status: CLAuthorizationStatus) -> Authorization {
    switch status {
    case .notDetermined: return .notDetermined
    case .restricted: return .restricted
    case .denied: return .denied
    case .authorizedAlways: return .always
    case .authorizedWhenInUse: return .whenInUse
    @unknown default: return .denied
    }
  }

  // MARK: - Handlers (main actor)

  private func handleAuthorization(_ new: Authorization, precise: Bool) {
    if new != authorization || precise != isPrecise {
      log("authorization \(authorization) -> \(new), precise \(precise)")
    }
    authorization = new
    isPrecise = precise
    switch new {
    case .whenInUse, .always:
      lastError = precise ? nil : "Precise Location is off for Shift Memory, so photos and the shift track can't be placed on the map. Turn it on in Settings > Privacy & Security > Location Services."
      if mode != .off { apply() }
    case .denied:
      lastError = "Location access is off for Shift Memory, so photos and the shift track won't appear on the map. Allow it in Settings > Privacy & Security > Location Services."
      stopUpdates()
    case .restricted:
      lastError = "Location is restricted on this iPhone, so photos and the shift track won't appear on the map."
      stopUpdates()
    case .notDetermined:
      break
    }
  }

  private func handleFixes(_ fixes: [LocationFix]) {
    let now = Date()
    let barometric = barometricFloor?()
    for rawFix in fixes {
      var fix = rawFix
      fix.floor = FloorQuantizer.resolve(venueFloor: rawFix.floor, barometricFloor: barometric)
      if !loggedFirstFix {
        loggedFirstFix = true
        log("first fix (\(mode)): accuracy \(Int(fix.accuracyM.rounded())) m, age \(Int(now.timeIntervalSince(fix.t).rounded())) s")
      }
      if now.timeIntervalSince(fix.t) <= Self.maxDeliveryAge, fix.t > (latest?.t ?? .distantPast) {
        latest = fix
      }
      guard mode == .shift, let started = shiftStartedAt, fix.t >= started else { continue }
      guard sampler.accept(fix) else { continue }
      keptPoints += 1
      if keptPoints % Self.logEveryKeptPoints == 0 {
        log("track: \(keptPoints) points kept, last accuracy \(Int(fix.accuracyM.rounded())) m")
      }
      onTrackPoint?(fix)
    }
  }

  private func handleError(code: CLError.Code?, description: String) {
    switch code {
    case .locationUnknown:
      return  // Transient: Core Location keeps trying.
    case .denied:
      log("error: denied")
      lastError = "Location access is off for Shift Memory, so photos and the shift track won't appear on the map. Allow it in Settings > Privacy & Security > Location Services."
      stopUpdates()
    default:
      log("error: \(description)")
    }
  }

  /// Runs `body` on the main actor; synchronously when already on the main thread (always, since
  /// the manager was created there), otherwise via a main-actor task.
  private nonisolated func onMain(_ body: @escaping @MainActor @Sendable (LocationTracker) -> Void) {
    if Thread.isMainThread {
      MainActor.assumeIsolated { body(self) }
    } else {
      Task { @MainActor in body(self) }
    }
  }
}

// MARK: - CLLocationManagerDelegate

extension LocationTracker: CLLocationManagerDelegate {
  nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = Self.map(manager.authorizationStatus)
    let precise = manager.accuracyAuthorization == .fullAccuracy
    onMain { $0.handleAuthorization(status, precise: precise) }
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    let fixes = locations.compactMap(LocationFix.init)
    guard !fixes.isEmpty else { return }
    onMain { $0.handleFixes(fixes) }
  }

  nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: any Error) {
    let code = (error as? CLError)?.code
    let description = error.localizedDescription
    onMain { $0.handleError(code: code, description: description) }
  }
}
