//
// GlassesController.swift
// Shift Memory
//
// The glasses side of capture (issue #1), on top of the Meta Wearables Device Access Toolkit 1.0.1:
// registration with the Meta AI app, the camera permission, one DeviceSession with a Camera whose
// standalone Photo child is started, and the two ways a photo arrives on that child's listener:
// the wearer pressing the shutter button on the glasses, or this app calling capturePhoto. Both
// land in `onPhoto`; the controller tags which one it was by whether an app capture was in flight,
// since the toolkit's publisher carries no request id (keep one capture in flight at a time).
//
// API names are taken from the SDK's public swiftinterface (MWDATCore, MWDATCamera 1.0.1), never
// guessed. Session and photo lifecycles are observed, not assumed; the device decides transitions.
//

import Foundation
import MWDATCamera
import MWDATCore
import Observation
import UIKit

/// Diagnostic log line; lands in Application Support/debug.log (see `DebugLog`) and the syslog.
func glassesLog(_ message: String) {
  DebugLog.write("Glasses", message)
}

/// Everything we can learn about an SDK error's underlying cause, for the syslog.
func describeUnderlying(_ error: (any Error)?) -> String {
  guard let error else { return "nil" }
  let ns = error as NSError
  return "\(String(reflecting: error)) {domain=\(ns.domain) code=\(ns.code) userInfo=\(ns.userInfo)}"
}

/// Photo bytes from the glasses, by either path, with everything the pipeline and diagnostics need.
struct GlassesPhoto: Sendable {
  let data: Data
  let metadata: Data?
  /// `PhotoCaptureData.timestamp`: phone-side time when the first transport half arrived.
  let deliveredAt: Date
  /// Phone wall clock when the listener fired.
  let receivedAt: Date
  /// `active` | `inactive` | `background` when the bytes arrived (issue #10's first question).
  let appState: String
  /// True when this app had a `capturePhoto` in flight; otherwise the wearer pressed the shutter.
  let isAppRequested: Bool
  /// The capture attempt id (`appRequested` only), so diagnostics can join request and delivery.
  let captureId: String?
  let requestedResolution: String?
  let requestedQuality: String?
  let firstProgressAt: Date?
  let glassesBattery: Int?
}

enum GlassesEvent: Sendable {
  case sessionStartSucceeded(ms: Int)
  case sessionStartFailed(error: String)
  case photoStartSucceeded(ms: Int)
  case photoStartFailed(error: String)
  case sessionStopped(reason: String?)
}

@MainActor
@Observable
final class GlassesController {
  enum Phase: Equatable, Sendable {
    /// `Wearables.configure()` failed; the rest of the app still works.
    case unavailable(String)
    /// Registered with Meta AI? Not yet: show Connect.
    case notRegistered
    case registering
    /// Registered, no glasses in range or linked.
    case noDevice
    /// Glasses found; a shift can start.
    case deviceAvailable
    /// Session starting, camera attaching, photo child starting.
    case starting
    /// Photo child started: shutter photos flow, the Capture button is live.
    case ready
    /// An app-requested capture is in flight (transfer fraction when known).
    case capturing
    case paused
    /// Terminal for this session; a new one can be started.
    case stopped

    var isLive: Bool { self == .ready || self == .capturing || self == .paused }
  }

  // MARK: Observable state
  private(set) var phase: Phase = .notRegistered
  private(set) var registrationState: RegistrationState = .unavailable
  private(set) var permission: PermissionStatus?
  private(set) var deviceName: String?
  private(set) var deviceBattery: Int?
  private(set) var deviceLink: LinkState?
  private(set) var sessionState: DeviceSessionState?
  private(set) var photoState: PhotoState?
  private(set) var transferFraction: Double?
  private(set) var transferBytes: (received: UInt64, total: UInt64)?
  private(set) var lastError: String?
  private(set) var stopReason: String?
  private(set) var needsGlassesAppUpdate = false
  private(set) var needsFirmwareUpdate = false
  /// Set while the wearer's pressed-the-shutter photos are expected to appear here.
  var isSessionLive: Bool { phase.isLive }

  // MARK: Hooks (set by the composition root)
  var onPhoto: ((GlassesPhoto) async -> Void)?
  var onEvent: ((GlassesEvent) -> Void)?

  // MARK: Private
  private let wearables: (any WearablesInterface)?
  private var selector: AutoDeviceSelector?
  private var session: DeviceSession?
  private var camera: Camera?
  private var photo: Photo?
  private var sessionTokens = ListenerTokenBag()
  private var deviceTokens = ListenerTokenBag()
  private var observers: [Task<Void, Never>] = []
  private var pending: PendingCapture?
  private var retriedSetupOnce = false
  /// Set once per camera attempt when `photo.start()` has been asked for (by the ignition stream).
  private var photoStartRequested = false
  /// Finishing this ends the current `waitForPhotoStarted` as a failure (a setup error arrived).
  private var photoStartWaiter: AsyncStream<PhotoState>.Continuation?
  /// Set once the camera reported `.started`. A camera is born `.stopped` too, so only one that was
  /// up and went down is a loss worth reviving (BirdSpotter's `cameraHasStarted`).
  private var cameraHasStarted = false
  /// The in-flight revival (see `revive(reason:)`); one at a time.
  private var revival: Task<Void, Never>?

  private struct PendingCapture {
    let id: String
    let requestedAt: Date
    let resolution: PhotoResolution
    let quality: PhotoQuality
    var firstProgressAt: Date?
    var lastProgressAt: Date?
    var timeout: Task<Void, Never>?
  }

  init(wearables: (any WearablesInterface)? = GlassesController.sharedWearables()) {
    self.wearables = wearables
    if let wearables {
      registrationState = wearables.registrationState
      phase = registrationState == .registered ? .noDevice : .notRegistered
    } else {
      phase = .unavailable("The Meta wearables toolkit did not start. Check Info.plist MWDAT keys.")
    }
  }

  /// `Wearables.shared` traps if `configure()` never succeeded; the app entry point configures first.
  nonisolated static func sharedWearables() -> (any WearablesInterface)? {
    Wearables.shared
  }

  // MARK: - Observation

  /// Start the long-lived observers: registration state and device availability.
  func startObserving() {
    guard observers.isEmpty, let wearables else { return }
    observers.append(Task { [weak self] in
      for await state in wearables.registrationStateStream() {
        guard let self else { return }
        self.registrationState = state
        switch state {
        case .registered:
          if !self.phase.isLive && self.phase != .starting { self.phase = self.selector?.activeDevice == nil ? .noDevice : .deviceAvailable }
          await self.refreshPermission()
        case .registering: self.phase = .registering
        case .available: if !self.phase.isLive { self.phase = .notRegistered }
        case .unavailable: if !self.phase.isLive { self.phase = .notRegistered }
        @unknown default: break
        }
      }
    })
    let selector = AutoDeviceSelector(wearables: wearables)
    self.selector = selector
    observers.append(Task { [weak self] in
      for await deviceId in selector.activeDeviceStream() {
        guard let self else { return }
        await self.deviceTokens.cancelAll()
        self.deviceTokens = ListenerTokenBag()
        if let deviceId, let device = wearables.deviceForIdentifier(deviceId) {
          self.deviceName = device.nameOrId()
          self.deviceBattery = device.batteryLevel
          self.deviceLink = device.linkState
          self.needsFirmwareUpdate = device.compatibility() == .deviceUpdateRequired
          device.addDeviceStateListener { [weak self] state in
            Task { @MainActor in
              guard let self else { return }
              self.deviceBattery = state.batteryLevel
              self.deviceLink = state.linkState
              self.needsFirmwareUpdate = state.compatibility == .deviceUpdateRequired
            }
          }.store(in: self.deviceTokens)
          if self.registrationState == .registered, !self.phase.isLive, self.phase != .starting { self.phase = .deviceAvailable }
        } else {
          self.deviceName = nil
          self.deviceBattery = nil
          self.deviceLink = nil
          if self.registrationState == .registered, !self.phase.isLive, self.phase != .starting { self.phase = .noDevice }
        }
      }
    })
  }

  // MARK: - Registration and permission

  /// Opens the Meta AI app so the wearer approves this app. Meta AI calls back via the URL scheme.
  func connect() async {
    guard let wearables else { return }
    lastError = nil
    do {
      phase = .registering
      try await wearables.startRegistration()
    } catch {
      phase = .notRegistered
      lastError = error.description
    }
  }

  func disconnect() async {
    guard let wearables else { return }
    endShift(reason: "Disconnected")
    do { try await wearables.startUnregistration() } catch { lastError = error.description }
    phase = .notRegistered
  }

  func handle(callbackURL url: URL) async {
    guard let wearables else { return }
    do { _ = try await wearables.handleUrl(url) } catch { lastError = error.description }
  }

  func refreshPermission() async {
    guard let wearables, registrationState == .registered else { return }
    permission = try? await wearables.checkPermissionStatus(.camera)
  }

  /// Requests the camera permission through Meta AI when it is not already granted.
  private func ensureCameraPermission() async -> Bool {
    guard let wearables else { return false }
    do {
      var status = try await wearables.checkPermissionStatus(.camera)
      if status != .granted { status = try await wearables.requestPermission(.camera) }
      permission = status
      return status == .granted
    } catch {
      lastError = error.description
      return false
    }
  }

  func openFirmwareUpdate() async { try? await wearables?.openFirmwareUpdate() }
  func openGlassesAppUpdate() async { try? await wearables?.openDATGlassesAppUpdate() }

  // MARK: - Shift (session) lifecycle

  /// Create and start the device session, attach the camera, start the standalone Photo child.
  /// When this returns with `phase == .ready`, shutter-button photos arrive on `onPhoto`.
  func startShift() async {
    guard let wearables, let selector else { return }
    guard !phase.isLive, phase != .starting else { return }
    lastError = nil
    stopReason = nil
    needsGlassesAppUpdate = false
    phase = .starting

    guard await ensureCameraPermission() else {
      phase = selector.activeDevice == nil ? .noDevice : .deviceAvailable
      if lastError == nil { lastError = "Camera access was not granted in the Meta AI app." }
      return
    }

    let t0 = Date()
    let session: DeviceSession
    do {
      session = try wearables.createSession(deviceSelector: selector)
    } catch {
      fail(start: error.description, at: t0)
      return
    }
    self.session = session

    // Subscribe before start() so no transition is missed.
    let states = session.stateStream()
    session.errorPublisher.listen { [weak self] error in
      Task { @MainActor in self?.sessionError(error) }
    }.store(in: sessionTokens)
    session.statePublisher.listen { [weak self] state in
      Task { @MainActor in self?.sessionStateChanged(state) }
    }.store(in: sessionTokens)

    do {
      try session.start()
    } catch {
      if error == .datAppOnTheGlassesUpdateRequired { needsGlassesAppUpdate = true }
      fail(start: error.description, at: t0)
      return
    }

    let started = await waitForSessionStarted(states, timeout: .seconds(25))
    guard started else {
      fail(start: lastError ?? "The glasses did not start the session in time.", at: t0)
      return
    }
    onEvent?(.sessionStartSucceeded(ms: Int(Date().timeIntervalSince(t0) * 1000)))

    deviceName = session.device?.nameOrId() ?? deviceName
    deviceBattery = session.device?.batteryLevel ?? deviceBattery

    await startPhotoChild()
  }

  /// Attach the camera and start its Photo child; retried once with a fresh camera on setup failure
  /// (the 1.0 docs: startup is the most common failure).
  private func startPhotoChild() async {
    guard let session else { return }
    let t0 = Date()
    glassesLog("startPhotoChild: retriedSetupOnce=\(retriedSetupOnce) session.state=\(session.state) camera(old)=\(camera.map { "\($0.state)" } ?? "nil")")
    camera?.stop()
    camera = nil
    photo = nil
    let camera: Camera
    do {
      // Smallest stream the SDK offers: its frames only exist to power the sensor (see below).
      let ignition = StreamConfiguration(videoCodec: .hvc1, resolution: .low, frameRate: 7)
      guard let c = try session.addCamera(config: ignition) else {
        fail(photoStart: "The session is not started, so the camera cannot be added yet.", at: t0)
        return
      }
      camera = c
      glassesLog("addCamera ok; camera.state=\(c.state)")
    } catch {
      glassesLog("addCamera threw: \(String(reflecting: error))")
      fail(photoStart: error.description, at: t0)
      return
    }
    self.camera = camera
    let photo = camera.photo
    self.photo = photo
    photoStartRequested = false
    cameraHasStarted = camera.state == .started
    revival?.cancel()
    revival = nil

    // Register every listener before start(); the publishers do not replay (and a camera that is
    // already where it is going to be says nothing, so its state is also read directly above).
    camera.statePublisher.listen { [weak self] state in
      glassesLog("camera state -> \(state)")
      Task { @MainActor in
        guard let self, self.camera === camera else { return }
        self.cameraStateChanged(state)
      }
    }.store(in: sessionTokens)
    // Ignition. On real glasses `Photo.start()` on a cold camera does not come up (it hangs in
    // `.starting` or fails with sessionSetupFailed): the Camera parent does not power the sensor,
    // only a child asking for frames does. Meta's own DAT 1.0.1 sample (BirdSpotter,
    // DatGlassesSessionRepository.attachCameraIfNeeded) therefore starts a tiny stream, starts Photo
    // once the stream is `.streaming`, and puts the stream down once Photo is `.started` (the two
    // children compete for the sensor). Same sequence here.
    camera.stream.statePublisher.listen { [weak self] state in
      glassesLog("ignition stream state -> \(state)")
      if case .streaming = state {
        Task { @MainActor in
          guard let self, self.camera === camera else { return }
          self.requestPhotoStart(reason: "stream is streaming")
        }
      }
    }.store(in: sessionTokens)
    camera.stream.errorPublisher.listen { [weak self] error in
      glassesLog("ignition stream error: \(String(reflecting: error)) — \(error.description)")
      // A stream that cannot come up should not block the photo child: fall back to starting it cold.
      Task { @MainActor in
        guard let self, self.camera === camera else { return }
        self.requestPhotoStart(reason: "stream error \(error.description)")
      }
    }.store(in: sessionTokens)
    let (photoStates, continuation) = AsyncStream<PhotoState>.makeStream()
    photoStartWaiter = continuation
    photo.statePublisher.listen { [weak self] state in
      glassesLog("photo state -> \(state)")
      continuation.yield(state)
      Task { @MainActor in
        // A camera from a failed earlier attempt must not overwrite the current one's state.
        guard let self, self.photo === photo else { return }
        self.photoStateChanged(state)
      }
    }.store(in: sessionTokens)
    photo.photoDataPublisher.listen { [weak self] capture in
      let receivedAt = Date()
      Task { @MainActor in await self?.photoArrived(capture, receivedAt: receivedAt) }
    }.store(in: sessionTokens)
    photo.transferProgressPublisher.listen { [weak self] progress in
      Task { @MainActor in self?.transferProgressed(progress) }
    }.store(in: sessionTokens)
    photo.errorPublisher.listen { [weak self] error in
      Task { @MainActor in
        guard let self else { return }
        guard self.photo === photo else {
          glassesLog("photo error from a superseded camera (ignored): \(String(reflecting: error))")
          return
        }
        await self.photoError(error)
      }
    }.store(in: sessionTokens)

    glassesLog("camera.stream.start() (ignition)")
    camera.stream.start()
    let started = await waitForPhotoStarted(photoStates, timeout: .seconds(30))
    continuation.finish()
    photoStartWaiter = nil
    glassesLog("waitForPhotoStarted -> \(started) after \(Int(Date().timeIntervalSince(t0) * 1000)) ms; photoState=\(photoState.map { "\($0)" } ?? "nil") lastError=\(lastError ?? "nil")")
    guard started else {
      if !retriedSetupOnce {
        retriedSetupOnce = true
        lastError = "Camera startup failed once; retrying with a fresh camera."
        await startPhotoChild()
        return
      }
      fail(photoStart: lastError ?? "The camera did not start in time.", at: t0)
      return
    }
    retriedSetupOnce = false
    onEvent?(.photoStartSucceeded(ms: Int(Date().timeIntervalSince(t0) * 1000)))
    phase = .ready
  }

  /// Stop the camera (cascades to Photo) and the session. Safe to call at any time.
  func endShift(reason: String? = nil) {
    pending?.timeout?.cancel()
    pending = nil
    revival?.cancel()
    revival = nil
    camera?.stop()
    session?.stop()
    camera = nil
    photo = nil
    session = nil
    let tokens = sessionTokens
    sessionTokens = ListenerTokenBag()
    Task { await tokens.cancelAll() }
    transferFraction = nil
    transferBytes = nil
    photoState = nil
    sessionState = nil
    stopReason = reason
    if phase.isLive || phase == .starting { phase = .stopped }
  }

  // MARK: - Capture

  /// Ask the glasses for a standalone photo. Returns the capture attempt id, or nil when a capture
  /// is already in flight or the photo child is not ready.
  @discardableResult
  func capture(resolution: PhotoResolution, quality: PhotoQuality) -> String? {
    guard phase == .ready, pending == nil, let photo, photoState == .started else {
      if pending != nil { lastError = "A capture is already in progress." }
      else if phase != .ready { lastError = "Start the shift before capturing." }
      return nil
    }
    lastError = nil
    let id = UUID().uuidString.lowercased()
    var p = PendingCapture(id: id, requestedAt: Date(), resolution: resolution, quality: quality)
    // The toolkit fails a capture silent for 30 s; give it a little longer before we give up. A
    // full/high photo can take longer than that over Bluetooth (~45 s observed on 016N), so while
    // transfer progress keeps arriving we keep waiting, and give up after 20 s without progress.
    p.timeout = Task { [weak self] in
      try? await Task.sleep(for: .seconds(40))
      while !Task.isCancelled {
        guard self?.pending?.id == id, let last = self?.pending?.lastProgressAt,
              Date().timeIntervalSince(last) < 20 else { break }
        try? await Task.sleep(for: .seconds(5))
      }
      guard !Task.isCancelled, let self, self.pending?.id == id else { return }
      self.lastError = self.pending?.firstProgressAt == nil
        ? "The glasses did not start sending the photo within 40 s."
        : "The glasses stopped sending the photo (no transfer progress for 20 s)."
      self.pending = nil
      self.transferFraction = nil
      self.transferBytes = nil
      if self.phase == .capturing { self.phase = .ready }
    }
    pending = p
    phase = .capturing
    transferFraction = nil
    transferBytes = nil
    photo.capturePhoto(resolution: resolution, quality: quality)
    return id
  }

  #if DEBUG
  /// Debug-only: a capture that is NOT marked as app-requested, so the delivery is treated like a
  /// wearer's shutter press. Lets the shutter path be exercised with MockDeviceKit.
  func debugSimulateShutterPress() {
    guard let photo, photoState == .started else { lastError = "Photo capability is not started."; return }
    photo.capturePhoto(resolution: .medium, quality: .medium)
  }
  #endif

  // MARK: - Listener handlers (main actor)

  private func sessionStateChanged(_ state: DeviceSessionState) {
    glassesLog("session state -> \(state) (phase=\(phase))")
    sessionState = state
    switch state {
    case .paused:
      if phase.isLive { phase = .paused }
    case .started:
      if phase == .paused {
        if photoState == .started {
          phase = .ready
        } else {
          // The session is back but the photo child is not: ask the camera back (issue #10 risk:
          // a pause/resume used to leave the phase at `.starting` with nothing restarting Photo).
          phase = .starting
          revive(reason: "session resumed with photo child \(photoState.map { "\($0)" } ?? "nil")")
        }
      }
    case .stopped:
      let reason = stopReason ?? lastError ?? "The glasses ended the session (folded, out of range, or another app took the camera)."
      onEvent?(.sessionStopped(reason: reason))
      endShift(reason: reason)
    default:
      break
    }
  }

  private func sessionError(_ error: DeviceSessionError) {
    glassesLog("session error: \(String(reflecting: error)) — \(error.description)")
    switch error {
    case .datAppOnTheGlassesUpdateRequired:
      needsGlassesAppUpdate = true
      lastError = error.description
    case .dwaOutOfStuRange:
      // Non-blocking compatibility warning per the 1.0 changelog.
      break
    default:
      lastError = error.description
    }
  }

  /// Starts the Photo child once per camera attempt (normally when the ignition stream streams).
  private func requestPhotoStart(reason: String) {
    guard !photoStartRequested, let photo, phase == .starting else { return }
    photoStartRequested = true
    glassesLog("photo.start() — \(reason)")
    photo.start()
  }

  /// Puts the ignition stream down once Photo holds the sensor, so stills are not blocked by frames.
  private func releaseIgnitionStream() {
    guard let stream = camera?.stream else { return }
    switch stream.state {
    case .stopped, .stopping: return
    default:
      glassesLog("ignition stream stop() — photo has the sensor")
      stream.stop()
    }
  }

  private func photoStateChanged(_ state: PhotoState) {
    photoState = state
    switch state {
    case .started:
      releaseIgnitionStream()
      if phase == .starting || phase == .paused { phase = .ready }
    case .stopped, .stopping:
      // During startup a stop is `startPhotoChild`'s business (its waiter fails and retries).
      guard phase.isLive else { break }
      // Asked again the next time the ignition frames flow (BirdSpotter does the same).
      photoStartRequested = false
      failPendingCapture("The glasses' camera stopped before the photo arrived.")
      if session?.state == .started {
        phase = .starting
        revive(reason: "photo child \(state) while live")
      } else if phase != .paused {
        phase = .stopped
      }
    default:
      break
    }
  }

  private func cameraStateChanged(_ state: CameraState) {
    switch state {
    case .started:
      cameraHasStarted = true
    case .stopped, .stopping:
      // Only a camera that was up and went down means anything; the one the retry just replaced
      // is filtered out by the caller's identity check.
      guard cameraHasStarted, phase.isLive || phase == .starting else { return }
      cameraHasStarted = false
      photoStartRequested = false
      failPendingCapture("The glasses' camera stopped before the photo arrived.")
      if phase.isLive, phase != .paused { phase = .starting }
      if session?.state == .started { revive(reason: "camera \(state) without being asked to") }
    default:
      break
    }
  }

  /// Fail the in-flight app capture (if any) with `message`; the wearer sees it as `lastError`.
  private func failPendingCapture(_ message: String) {
    guard pending != nil else { return }
    pending?.timeout?.cancel()
    pending = nil
    transferFraction = nil
    transferBytes = nil
    lastError = message
  }

  /// Ask the camera back after it, or its Photo child, went down under a live session, the way
  /// Meta's DAT 1.0.1 sample does (BirdSpotter `reviveCamera` / `bringCameraBack`): restart the
  /// ignition stream, which powers the sensor; its `.streaming` state re-runs `photo.start()`
  /// (`requestPhotoStart`), and Photo reaching `.started` puts the stream down again and moves the
  /// phase back to `.ready` (`photoStateChanged`). `start()` answers only on the state publishers,
  /// so each attempt is given a few seconds before the next; three attempts, then the shift ends.
  private func revive(reason: String) {
    guard revival == nil else { glassesLog("revive (\(reason)): already in progress"); return }
    guard let camera, let session, session.state == .started else {
      glassesLog("revive (\(reason)) skipped: camera=\(camera != nil) session.state=\(session.map { "\($0.state)" } ?? "nil")")
      return
    }
    glassesLog("revive: \(reason); camera.state=\(camera.state) stream.state=\(camera.stream.state) photoState=\(self.photoState.map { "\($0)" } ?? "nil")")
    revival = Task { [weak self] in
      defer { Task { @MainActor [weak self] in self?.revival = nil } }
      for attempt in 1...3 {
        // A beat for the crossing to settle; a stop that arrived late about a camera already back is a no-op.
        try? await Task.sleep(for: .milliseconds(750))
        guard let self, !Task.isCancelled, self.camera === camera, self.phase == .starting else { return }
        if self.photoState == .started { self.phase = .ready; return }
        glassesLog("revive attempt \(attempt)/3: camera.state=\(camera.state) stream.state=\(camera.stream.state) photoState=\(self.photoState.map { "\($0)" } ?? "nil")")
        self.photoStartRequested = false
        camera.stream.start()
        for _ in 0..<16 {   // up to 8 s per attempt (startup takes ~2 s on 016N)
          try? await Task.sleep(for: .milliseconds(500))
          guard !Task.isCancelled, self.camera === camera else { return }
          if self.photoState == .started {
            glassesLog("revive: photo child back up after attempt \(attempt)")
            if self.phase == .starting { self.phase = .ready }
            return
          }
          if self.phase != .starting { return }   // ended or failed elsewhere
        }
      }
      guard let self, !Task.isCancelled, self.camera === camera else { return }
      let message = "The glasses' camera stopped and did not come back; start the shift again."
      glassesLog("revive FAILED: \(message)")
      self.lastError = message
      self.onEvent?(.sessionStopped(reason: message))
      self.endShift(reason: message)
    }
  }

  private func transferProgressed(_ progress: PhotoTransferProgress) {
    transferFraction = progress.fraction
    transferBytes = (progress.bytesReceived, progress.totalBytes)
    if pending != nil {
      let now = Date()
      if pending?.firstProgressAt == nil { pending?.firstProgressAt = now }
      pending?.lastProgressAt = now
    }
  }

  private func photoArrived(_ capture: PhotoCaptureData, receivedAt: Date) async {
    let appState: String = switch UIApplication.shared.applicationState {
    case .active: "active"
    case .inactive: "inactive"
    case .background: "background"
    @unknown default: "unknown"
    }
    let p = pending
    pending?.timeout?.cancel()
    pending = nil
    transferFraction = nil
    transferBytes = nil
    if phase == .capturing { phase = .ready }
    let photo = GlassesPhoto(
      data: capture.imageData,
      metadata: capture.metadata,
      deliveredAt: capture.timestamp,
      receivedAt: receivedAt,
      appState: appState,
      isAppRequested: p != nil,
      captureId: p?.id,
      requestedResolution: p?.resolution.rawValue,
      requestedQuality: p?.quality.rawValue,
      firstProgressAt: p?.firstProgressAt,
      glassesBattery: session?.device?.batteryLevel ?? deviceBattery
    )
    await onPhoto?(photo)
  }

  private func photoError(_ error: PhotoError) async {
    let underlying: (any Error)? = switch error {
    case .sessionSetupFailed(let u), .captureFailure(let u): u
    default: nil
    }
    glassesLog("photo error: \(String(reflecting: error)) — \(error.description); underlying: \(describeUnderlying(underlying)); phase=\(phase) retriedSetupOnce=\(retriedSetupOnce) session.state=\(session.map { "\($0.state)" } ?? "nil")")
    lastError = error.description
    pending?.timeout?.cancel()
    pending = nil
    transferFraction = nil
    transferBytes = nil
    switch error {
    case .sessionSetupFailed:
      if phase == .starting, let waiter = photoStartWaiter {
        // During startup the retry belongs to startPhotoChild alone: end its wait as a failure.
        // (Retrying here too used to race it, and the loser's endShift tore the winner down.)
        waiter.finish()
      } else if phase.isLive, !retriedSetupOnce {
        // The docs: recreate the camera rather than reuse the stopped one.
        retriedSetupOnce = true
        phase = .starting
        await startPhotoChild()
      } else if phase.isLive {
        phase = .stopped
        stopReason = error.description
      }
    case .permissionDenied:
      permission = .denied
      endShift(reason: error.description)
    case .deviceDisconnected:
      endShift(reason: error.description)
    default:
      if phase == .capturing { phase = .ready }
    }
  }

  // MARK: - Waiting helpers

  private func waitForSessionStarted(_ states: AsyncStream<DeviceSessionState>, timeout: Duration) async -> Bool {
    if session?.state == .started { return true }
    return await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        for await s in states {
          if s == .started { return true }
          if s == .stopped { return false }
        }
        return false
      }
      group.addTask {
        try? await Task.sleep(for: timeout)
        return false
      }
      let first = await group.next() ?? false
      group.cancelAll()
      return first
    }
  }

  private func waitForPhotoStarted(_ states: AsyncStream<PhotoState>, timeout: Duration) async -> Bool {
    await withTaskGroup(of: Bool.self) { group in
      group.addTask {
        var sawStarting = false
        for await s in states {
          switch s {
          case .started: return true
          case .starting: sawStarting = true
          case .stopped: if sawStarting { return false }   // a return to stopped after starting is a setup failure
          case .stopping: break
          @unknown default: break
          }
        }
        return false
      }
      group.addTask {
        try? await Task.sleep(for: timeout)
        return false
      }
      let first = await group.next() ?? false
      group.cancelAll()
      return first
    }
  }

  private func fail(start message: String, at t0: Date) {
    lastError = message
    onEvent?(.sessionStartFailed(error: message))
    endShift(reason: message)
    phase = selector?.activeDevice == nil ? .noDevice : .deviceAvailable
  }

  private func fail(photoStart message: String, at t0: Date) {
    glassesLog("photo start FAILED: \(message)")
    lastError = message
    onEvent?(.photoStartFailed(error: message))
    endShift(reason: message)
    phase = selector?.activeDevice == nil ? .noDevice : .deviceAvailable
  }
}
