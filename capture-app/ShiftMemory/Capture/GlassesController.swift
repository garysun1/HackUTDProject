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

  private struct PendingCapture {
    let id: String
    let requestedAt: Date
    let resolution: PhotoResolution
    let quality: PhotoQuality
    var firstProgressAt: Date?
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
    camera?.stop()
    camera = nil
    photo = nil
    let camera: Camera
    do {
      guard let c = try session.addCamera() else {
        fail(photoStart: "The session is not started, so the camera cannot be added yet.", at: t0)
        return
      }
      camera = c
    } catch {
      fail(photoStart: error.description, at: t0)
      return
    }
    self.camera = camera
    let photo = camera.photo
    self.photo = photo

    // Register every listener before start(); the publishers do not replay.
    let (photoStates, continuation) = AsyncStream<PhotoState>.makeStream()
    photo.statePublisher.listen { [weak self] state in
      continuation.yield(state)
      Task { @MainActor in self?.photoStateChanged(state) }
    }.store(in: sessionTokens)
    photo.photoDataPublisher.listen { [weak self] capture in
      let receivedAt = Date()
      Task { @MainActor in await self?.photoArrived(capture, receivedAt: receivedAt) }
    }.store(in: sessionTokens)
    photo.transferProgressPublisher.listen { [weak self] progress in
      Task { @MainActor in self?.transferProgressed(progress) }
    }.store(in: sessionTokens)
    photo.errorPublisher.listen { [weak self] error in
      Task { @MainActor in await self?.photoError(error) }
    }.store(in: sessionTokens)

    photo.start()
    let started = await waitForPhotoStarted(photoStates, timeout: .seconds(20))
    continuation.finish()
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
    // The toolkit fails a capture silent for 30 s; give it a little longer before we give up.
    p.timeout = Task { [weak self] in
      try? await Task.sleep(for: .seconds(40))
      guard !Task.isCancelled, let self, self.pending?.id == id else { return }
      self.pending = nil
      self.transferFraction = nil
      self.transferBytes = nil
      self.lastError = "The glasses did not deliver the photo within 40 s."
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
    sessionState = state
    switch state {
    case .paused:
      if phase.isLive { phase = .paused }
    case .started:
      if phase == .paused { phase = photoState == .started ? .ready : .starting }
    case .stopped:
      let reason = stopReason ?? lastError ?? "The glasses ended the session (folded, out of range, or another app took the camera)."
      onEvent?(.sessionStopped(reason: reason))
      endShift(reason: reason)
    default:
      break
    }
  }

  private func sessionError(_ error: DeviceSessionError) {
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

  private func photoStateChanged(_ state: PhotoState) {
    photoState = state
    switch state {
    case .started:
      if phase == .starting || phase == .paused { phase = .ready }
    case .stopped:
      if phase == .capturing || phase == .ready { phase = session?.state == .started ? .starting : .stopped }
    default:
      break
    }
  }

  private func transferProgressed(_ progress: PhotoTransferProgress) {
    transferFraction = progress.fraction
    transferBytes = (progress.bytesReceived, progress.totalBytes)
    if pending != nil, pending?.firstProgressAt == nil { pending?.firstProgressAt = Date() }
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
    lastError = error.description
    pending?.timeout?.cancel()
    pending = nil
    transferFraction = nil
    transferBytes = nil
    switch error {
    case .sessionSetupFailed:
      // The docs: recreate the camera rather than reuse the stopped one.
      if phase == .starting || phase.isLive, !retriedSetupOnce {
        retriedSetupOnce = true
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
    lastError = message
    onEvent?(.photoStartFailed(error: message))
    endShift(reason: message)
    phase = selector?.activeDevice == nil ? .noDevice : .deviceAvailable
  }
}
