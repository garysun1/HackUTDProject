//
// AudioSessionCoordinator.swift
// Shift Memory
//
// The single owner of AVAudioSession for the app, so the capture chime, any spoken briefing and
// the voice narration after a capture stop fighting over the category. Two modes:
//
//   playback  `.playback` + `.duckOthers`: the chime/briefing dips the wearer's music rather than
//             stopping it, plays with the silent switch on, and goes to the glasses if they are the
//             current Bluetooth output (A2DP is implicit for output-only categories).
//   record    `.playAndRecord` + `.duckOthers` + `.defaultToSpeaker` + `.allowBluetoothA2DP`, and
//             `.allowBluetoothHFP` only when `useGlassesMic` is on, so the Ray-Ban Meta glasses'
//             microphone is the input when they are connected as a headset. Otherwise the built-in
//             mic is set as the preferred input and the glasses (if any) stay an A2DP output.
//             `.defaultToSpeaker` only matters with no Bluetooth/wired route: it sends output to
//             the loudspeaker instead of the earpiece so a chime is audible from the phone.
//
// `.duckOthers` implies `.mixWithOthers` (see the AVAudioSessionTypes.h notes), which is what lets
// a narration start while a call or music is active without killing it. While in record mode,
// asking for playback is a no-op: playAndRecord already plays, and switching category would cut
// the microphone mid-sentence.
//

import AVFoundation
import Foundation

@MainActor
final class AudioSessionCoordinator {
  enum Mode: Equatable { case inactive, playback, record }

  /// What the session was last activated for.
  private(set) var mode: Mode = .inactive

  /// Use the glasses' microphone (Bluetooth HFP) when they are connected as a headset. Applied on
  /// the next `activateForRecording()`.
  var useGlassesMic = true

  /// Called on the main actor with `true` when an interruption (a call, Siri) begins and `false`
  /// when it ends. The session is already inactive when `true` arrives.
  var onInterruption: ((Bool) -> Void)?

  private let session = AVAudioSession.sharedInstance()
  private nonisolated(unsafe) var observers: [NSObjectProtocol] = []

  init() {
    let token = NotificationCenter.default.addObserver(
      forName: AVAudioSession.interruptionNotification, object: AVAudioSession.sharedInstance(), queue: .main
    ) { [weak self] note in
      guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
      let began = type == .began
      MainActor.assumeIsolated { self?.handleInterruption(began: began) }
    }
    observers.append(token)
  }

  deinit {
    for token in observers { NotificationCenter.default.removeObserver(token) }
  }

  /// Make the session able to play the chime or a spoken briefing. Keeps record mode if active.
  func activateForPlayback() throws {
    if mode == .record { return }
    if session.category != .playback || !session.categoryOptions.contains(.duckOthers) {
      try session.setCategory(.playback, mode: .default, options: [.duckOthers])
    }
    try session.setActive(true, options: [])
    mode = .playback
  }

  /// Make the session able to record narration (and still play). Picks the input per `useGlassesMic`.
  func activateForRecording() throws {
    var options: AVAudioSession.CategoryOptions = [.duckOthers, .defaultToSpeaker, .allowBluetoothA2DP]
    if useGlassesMic { options.insert(.allowBluetoothHFP) }
    try session.setCategory(.playAndRecord, mode: .default, options: options)
    try session.setActive(true, options: [])
    let inputs = session.availableInputs ?? []
    if useGlassesMic {
      // HFP already wins routing when allowed; preferring it explicitly covers a wired mic too.
      if let headset = inputs.first(where: { $0.portType == .bluetoothHFP }) {
        try? session.setPreferredInput(headset)
      }
    } else if let builtIn = inputs.first(where: { $0.portType == .builtInMic }) {
      try? session.setPreferredInput(builtIn)
    }
    mode = .record
  }

  /// Release the session so ducked audio comes back. Errors (I/O still running) are ignored.
  func deactivate() {
    guard mode != .inactive else { return }
    try? session.setPreferredInput(nil)
    try? session.setActive(false, options: [.notifyOthersOnDeactivation])
    mode = .inactive
  }

  /// "in: Built-In Microphone [MicrophoneBuiltIn] → out: Ray-Ban Meta [BluetoothHFP]" for logs.
  var routeDescription: String {
    let route = session.currentRoute
    func describe(_ ports: [AVAudioSessionPortDescription]) -> String {
      ports.isEmpty ? "none" : ports.map { "\($0.portName) [\($0.portType.rawValue)]" }.joined(separator: ", ")
    }
    return "in: \(describe(route.inputs)) → out: \(describe(route.outputs))"
  }

  private func handleInterruption(began: Bool) {
    if began { mode = .inactive }
    onInterruption?(began)
  }
}
