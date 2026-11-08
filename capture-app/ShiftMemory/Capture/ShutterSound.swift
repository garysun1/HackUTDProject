//
// ShutterSound.swift
// Shift Memory
//
// Audible confirmation that a photo was taken, played on the phone the instant the glasses report
// the capture-button press (and when the app's own Capture button is tapped), not 40 s later when
// the bytes land. The toolkit gives apps no way to play on the glasses' speakers, so the phone is
// the only speaker we have; the sound is modelled on Meta's own capture chime: a short, soft,
// rising two-note bell (C6 → E6) with a faint click at the onset, about a third of a second.
//
// The sample is synthesized at startup into a WAV in memory (no asset to ship) and decoded once by
// AVAudioPlayer, which is pre-rolled so `play()` is near-instant. The audio session is `.playback`
// so the chime plays with the ring/silent switch on silent and while the phone is locked (the app
// keeps running in the background for the glasses session; `audio` is in UIBackgroundModes), and
// `.mixWithOthers` + `.duckOthers` so it dips rather than stops the wearer's music or call.
//

import AVFoundation
import Foundation
import UIKit

@MainActor
final class ShutterSound {
  private var player: AVAudioPlayer?
  private let haptic = UIImpactFeedbackGenerator(style: .medium)
  private var sessionConfigured = false

  init() {
    if let player = try? AVAudioPlayer(data: Self.chimeWAV(), fileTypeHint: AVFileType.wav.rawValue) {
      player.volume = 0.9
      player.prepareToPlay()
      self.player = player
    }
    haptic.prepare()
  }

  /// Play the chime (and a tap) now. Safe to call from any phase; overlapping calls restart it.
  func play() {
    configureSessionIfNeeded()
    guard let player else { return }
    player.currentTime = 0
    player.play()
    haptic.impactOccurred()
    haptic.prepare()
  }

  private func configureSessionIfNeeded() {
    let session = AVAudioSession.sharedInstance()
    if !sessionConfigured {
      do {
        try session.setCategory(.playback, mode: .default, options: [.mixWithOthers, .duckOthers])
        sessionConfigured = true
      } catch {
        glassesLog("shutter sound: audio session category failed: \(error)")
      }
    }
    // Activation is per play so an interruption (a call) or the system deactivating us does not
    // leave the next chime silent; deactivation lets the ducked audio come back.
    try? session.setActive(true, options: [])
  }

  // MARK: - Synthesis

  /// 44.1 kHz mono 16-bit PCM WAV, ~340 ms.
  static func chimeWAV() -> Data {
    let sampleRate = 44_100.0
    let duration = 0.34
    let count = Int(sampleRate * duration)
    var samples = [Float](repeating: 0, count: count)

    // Each note: fundamental plus a quieter octave and a touch of the 12th for a bell-like tone,
    // fast attack (4 ms), exponential decay.
    func addNote(freq: Double, start: Double, length: Double, gain: Float, decay: Double) {
      let s0 = Int(start * sampleRate)
      let n = Int(length * sampleRate)
      for i in 0..<n where s0 + i < count {
        let t = Double(i) / sampleRate
        let attack = min(1.0, t / 0.004)
        let env = attack * exp(-t / decay)
        let w = 2 * Double.pi * freq * t
        let v = sin(w) + 0.35 * sin(2 * w) + 0.12 * sin(3 * w)
        samples[s0 + i] += Float(env * v) * gain
      }
    }
    addNote(freq: 1046.50, start: 0.000, length: 0.20, gain: 0.42, decay: 0.060)   // C6
    addNote(freq: 1318.51, start: 0.075, length: 0.26, gain: 0.48, decay: 0.085)   // E6

    // A faint mechanical click at the onset: a few ms of decaying noise, low in the mix.
    var seed: UInt32 = 0x9E37_79B9
    for i in 0..<Int(0.012 * sampleRate) {
      seed = seed &* 1_664_525 &+ 1_013_904_223
      let noise = Float(Int32(bitPattern: seed)) / Float(Int32.max)
      let env = exp(-Double(i) / (0.0035 * sampleRate))
      samples[i] += noise * Float(env) * 0.18
    }

    // Soft limiter and a 20 ms fade-out so the tail never clicks.
    let fade = Int(0.02 * sampleRate)
    for i in 0..<count {
      var v = samples[i]
      v = tanhf(v * 1.2) * 0.85
      if i > count - fade { v *= Float(count - i) / Float(fade) }
      samples[i] = v
    }

    var pcm = Data(capacity: count * 2)
    for v in samples {
      let s = Int16(max(-1, min(1, v)) * Float(Int16.max))
      withUnsafeBytes(of: s.littleEndian) { pcm.append(contentsOf: $0) }
    }
    return wav(pcm: pcm, sampleRate: Int(sampleRate), channels: 1, bitsPerSample: 16)
  }

  private static func wav(pcm: Data, sampleRate: Int, channels: Int, bitsPerSample: Int) -> Data {
    var d = Data()
    func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { d.append(contentsOf: $0) } }
    func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { d.append(contentsOf: $0) } }
    let blockAlign = channels * bitsPerSample / 8
    d.append(contentsOf: Array("RIFF".utf8)); u32(36 + pcm.count); d.append(contentsOf: Array("WAVE".utf8))
    d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(channels); u32(sampleRate)
    u32(sampleRate * blockAlign); u16(blockAlign); u16(bitsPerSample)
    d.append(contentsOf: Array("data".utf8)); u32(pcm.count); d.append(pcm)
    return d
  }
}
