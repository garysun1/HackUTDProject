//
// AltimeterFloorTracker.swift
// Shift Memory
//
// Which floor the wearer is on, from the iPhone's barometer (Core Motion `CMAltimeter`), for
// `event_json.location.floor` and the track points (contract v3.1, issue #19). Core Location's
// `CLFloor` is nil at ECSW (no indoor survey), so without this every point of the 3D site view sits
// on the ground floor.
//
// `startRelativeAltitudeUpdates` reports altitude relative to the moment updates started, so the
// tracker restarts updates when a shift starts: floor 0 is wherever the wearer stood then. Each
// sample goes through `FloorFusion` (barometer step + pedometer floors + GPS near a stair/elevator,
// drift re-zero while stationary), which wraps the `FloorQuantizer`'s hysteresis. The pedometer,
// activity and GPS come from closures the composition root sets (`ShiftMotion`, `LocationTracker`).
// Relative altitude drifts with the weather (a 1 hPa front is ~8 m), slowly; the fusion's rule (c)
// absorbs that while the wearer stands still. Needs `NSMotionUsageDescription` in Info.plist; the
// first start shows the Motion & Fitness prompt.
//
// Threading: updates are delivered on an OperationQueue we own and reduced to Doubles before
// hopping to the main actor, so no Core Motion object crosses an isolation boundary.
//

import CoreMotion
import Foundation
import Observation

@MainActor
@Observable
final class AltimeterFloorTracker {
  enum Availability: Equatable, Sendable {
    case unknown, available, unavailable, denied
  }

  /// Fewer log lines: one per this many altitude samples while nothing changes.
  static let logEverySamples = 300

  // MARK: Observable state
  private(set) var availability: Availability
  /// The floor relative to the shift start, nil while not tracking.
  private(set) var floor: Int?
  /// Metres above the shift start, straight from the altimeter; nil while not tracking.
  private(set) var relativeAltitudeM: Double?
  /// Air pressure in kilopascals, for the calibration log.
  private(set) var pressureKPa: Double?
  /// The fusion's last non-trivial decision, one line, for Settings and the calibration log.
  private(set) var lastDecision: String?
  private(set) var isTracking = false

  // MARK: Hooks (set by the composition root)
  /// Cumulative pedometer floors (up + down) since the shift started; nil when unknown.
  var pedometerFloors: (() -> Int?)?
  /// Whether the wearer is standing still; nil when unknown.
  var isStationary: (() -> Bool?)?
  /// The newest GPS fix; nil when none.
  var latestFix: (() -> LocationFix?)?

  // MARK: Private
  @ObservationIgnored private let altimeter: CMAltimeter
  @ObservationIgnored private let log: (String) -> Void
  @ObservationIgnored private var fusion: FloorFusion
  @ObservationIgnored private let queue: OperationQueue = {
    let q = OperationQueue()
    q.name = "shiftmemory.altimeter"
    q.maxConcurrentOperationCount = 1
    q.qualityOfService = .utility
    return q
  }()
  @ObservationIgnored private var samples = 0
  /// Bumped on every start so a late sample from a previous run is dropped.
  @ObservationIgnored private var generation = 0
  /// The last rejection logged, so a rejection that persists sample after sample is logged once.
  @ObservationIgnored private var lastRejectionKey: String?

  init(log: @escaping (String) -> Void, config: FloorFusion.Config = .init()) {
    self.altimeter = CMAltimeter()
    self.log = log
    self.fusion = FloorFusion(config: config)
    self.availability = CMAltimeter.isRelativeAltitudeAvailable() ? .available : .unavailable
    if CMAltimeter.authorizationStatus() == .denied || CMAltimeter.authorizationStatus() == .restricted {
      self.availability = .denied
    }
  }

  var config: FloorFusion.Config { fusion.config }
  /// Metres of drift absorbed so far (fusion rule c).
  var baselineOffsetM: Double { fusion.baselineOffsetM }

  /// Changes the floor height / hysteresis / sites. Mid-shift the fusion keeps the current floor and
  /// baseline and applies the new step from the next sample on.
  func setConfig(_ config: FloorFusion.Config) {
    guard config != fusion.config else { return }
    log("floor step \(fusion.config.quantizer.floorHeightM) m -> \(config.quantizer.floorHeightM) m (hysteresis \(config.quantizer.hysteresis))")
    fusion.setConfig(config)
  }

  /// A shift starts here: this altitude becomes floor 0. Restarts updates if already running.
  func startShift() {
    guard CMAltimeter.isRelativeAltitudeAvailable() else {
      availability = .unavailable
      log("relative altitude not available on this device; floor stays unset unless Core Location provides one")
      return
    }
    if isTracking { altimeter.stopRelativeAltitudeUpdates() }
    fusion.reset()
    samples = 0
    lastRejectionKey = nil
    lastDecision = nil
    generation += 1
    let gen = generation
    isTracking = true
    floor = 0
    relativeAltitudeM = 0
    log("relative altitude updates started: floor 0 is here (step \(fusion.config.quantizer.floorHeightM) m, hysteresis \(fusion.config.quantizer.hysteresis), \(fusion.config.sites.count) stair/elevator sites)")
    altimeter.startRelativeAltitudeUpdates(to: queue) { [weak self] data, error in
      // Reduce to Sendable values before leaving the queue.
      let altitude = data?.relativeAltitude.doubleValue
      let pressure = data?.pressure.doubleValue
      let errorText = error.map { ($0 as NSError).code == Int(CMErrorMotionActivityNotAuthorized.rawValue) ? "denied" : $0.localizedDescription }
      Task { @MainActor [weak self] in
        self?.handle(altitude: altitude, pressure: pressure, error: errorText, generation: gen)
      }
    }
  }

  /// The shift ended: stop the barometer; `floor` becomes nil.
  func stop() {
    guard isTracking else { return }
    altimeter.stopRelativeAltitudeUpdates()
    isTracking = false
    generation += 1
    log("relative altitude updates stopped after \(samples) samples; last floor \(floor.map(String.init) ?? "none"), baseline \(String(format: "%.2f", fusion.baselineOffsetM)) m")
    floor = nil
    relativeAltitudeM = nil
    pressureKPa = nil
  }

  // MARK: - Handling (main actor)

  private func handle(altitude: Double?, pressure: Double?, error: String?, generation gen: Int) {
    guard gen == generation, isTracking else { return }
    if let error {
      if error == "denied" {
        availability = .denied
        log("motion access denied; floor stays unset unless Core Location provides one")
        altimeter.stopRelativeAltitudeUpdates()
        isTracking = false
        floor = nil
        relativeAltitudeM = nil
      } else {
        log("error: \(error)")
      }
      return
    }
    guard let altitude else { return }
    availability = .available
    samples += 1
    relativeAltitudeM = altitude
    pressureKPa = pressure
    let sample = FloorFusion.Sample(
      t: Date(), relativeAltitudeM: altitude,
      pedometerFloors: pedometerFloors?(), isStationary: isStationary?(), fix: latestFix?()
    )
    let altText = String(format: "%.1f", altitude)
    switch fusion.update(sample) {
    case .none:
      if samples % Self.logEverySamples == 0 {
        log("\(samples) samples, \(altText) m relative, floor \(fusion.floor), baseline \(String(format: "%.2f", fusion.baselineOffsetM)) m")
      }
    case .accepted(let from, let to, let reason):
      lastRejectionKey = nil
      lastDecision = "accepted \(from) -> \(to): \(reason)"
      log("floor \(from) -> \(to) at \(altText) m relative; accepted: \(reason)")
      floor = to
    case .rejected(let from, let to, let reason):
      let key = "\(from)>\(to):\(reason)"
      lastDecision = "rejected \(from) -> \(to): \(reason)"
      if key != lastRejectionKey {
        lastRejectionKey = key
        log("floor \(from) -> \(to) at \(altText) m relative; REJECTED: \(reason)")
      }
    case .rezeroed(let by, let offset):
      lastRejectionKey = nil
      lastDecision = String(format: "re-zeroed by %+.2f m (baseline %.2f m)", by, offset)
      log(String(format: "drift while stationary: baseline moved %+.2f m to %.2f m, floor stays %d", by, offset, fusion.floor))
    }
  }
}
