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
// tracker restarts updates when a shift starts: floor 0 is wherever the wearer stood then. The
// `FloorQuantizer` turns metres into a floor with hysteresis. Relative altitude drifts with the
// weather (a 1 hPa front is ~8 m), slowly; a full shift may see a floor of drift, which is why the
// quantiser's hysteresis is wide and the step is adjustable in Settings. Needs
// `NSMotionUsageDescription` in Info.plist; the first start shows the Motion & Fitness prompt.
//
// Threading: updates are delivered on an OperationQueue we own and reduced to a Double before
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
  /// Metres above the shift start, nil while not tracking.
  private(set) var relativeAltitudeM: Double?
  private(set) var isTracking = false

  // MARK: Private
  @ObservationIgnored private let altimeter: CMAltimeter
  @ObservationIgnored private let log: (String) -> Void
  @ObservationIgnored private var quantizer: FloorQuantizer
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

  init(log: @escaping (String) -> Void, config: FloorQuantizer.Config = .init()) {
    self.altimeter = CMAltimeter()
    self.log = log
    self.quantizer = FloorQuantizer(config: config)
    self.availability = CMAltimeter.isRelativeAltitudeAvailable() ? .available : .unavailable
    if CMAltimeter.authorizationStatus() == .denied || CMAltimeter.authorizationStatus() == .restricted {
      self.availability = .denied
    }
  }

  var config: FloorQuantizer.Config { quantizer.config }

  /// Changes the floor height / hysteresis. Mid-shift the quantiser keeps the current floor and
  /// applies the new step from the next sample on (the altitude reference does not move).
  func setConfig(_ config: FloorQuantizer.Config) {
    guard config != quantizer.config else { return }
    var next = FloorQuantizer(config: config)
    if let alt = quantizer.lastAltitudeM {
      // Keep the floor we are on; re-evaluate the band from the current altitude.
      next = FloorQuantizer(config: config, floor: quantizer.floor)
      next.update(relativeAltitudeM: alt)
    }
    log("floor step \(quantizer.config.floorHeightM) m -> \(config.floorHeightM) m (hysteresis \(config.hysteresis))")
    quantizer = next
    if isTracking { floor = quantizer.floor }
  }

  /// A shift starts here: this altitude becomes floor 0. Restarts updates if already running.
  func startShift() {
    guard CMAltimeter.isRelativeAltitudeAvailable() else {
      availability = .unavailable
      log("relative altitude not available on this device; floor stays unset unless Core Location provides one")
      return
    }
    if isTracking { altimeter.stopRelativeAltitudeUpdates() }
    quantizer.reset()
    samples = 0
    generation += 1
    let gen = generation
    isTracking = true
    floor = 0
    relativeAltitudeM = 0
    log("relative altitude updates started: floor 0 is here (step \(quantizer.config.floorHeightM) m, hysteresis \(quantizer.config.hysteresis))")
    altimeter.startRelativeAltitudeUpdates(to: queue) { [weak self] data, error in
      // Reduce to Sendable values before leaving the queue.
      let altitude = data?.relativeAltitude.doubleValue
      let errorText = error.map { ($0 as NSError).code == Int(CMErrorMotionActivityNotAuthorized.rawValue) ? "denied" : $0.localizedDescription }
      Task { @MainActor [weak self] in
        self?.handle(altitude: altitude, error: errorText, generation: gen)
      }
    }
  }

  /// The shift ended: stop the barometer; `floor` becomes nil.
  func stop() {
    guard isTracking else { return }
    altimeter.stopRelativeAltitudeUpdates()
    isTracking = false
    generation += 1
    log("relative altitude updates stopped after \(samples) samples; last floor \(floor.map(String.init) ?? "none")")
    floor = nil
    relativeAltitudeM = nil
  }

  // MARK: - Handling (main actor)

  private func handle(altitude: Double?, error: String?, generation gen: Int) {
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
    if let changed = quantizer.update(relativeAltitudeM: altitude) {
      log("floor \(floor.map(String.init) ?? "?") -> \(changed) at \(String(format: "%.1f", altitude)) m relative")
      floor = changed
    } else if samples % Self.logEverySamples == 0 {
      log("\(samples) samples, \(String(format: "%.1f", altitude)) m relative, floor \(quantizer.floor)")
    }
  }
}
