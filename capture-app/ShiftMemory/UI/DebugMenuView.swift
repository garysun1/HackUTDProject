//
// DebugMenuView.swift
// Shift Memory
//
// DEBUG only. Drives MockDeviceKit so the whole path (session → camera → photo → pipeline → queue →
// ingest_photo) runs on the Simulator with no glasses. MockDeviceKit has to be enabled before
// `Wearables.configure()`, so the switch here is a persisted flag that takes effect on relaunch.
//

#if DEBUG
import MWDATMockDevice
import SwiftUI
import UIKit

enum DebugMock {
  static let flagKey = "debug.mockGlasses"
  static var isRequested: Bool {
    UserDefaults.standard.bool(forKey: flagKey) || CommandLine.arguments.contains("-mockGlasses")
  }
  /// Call before `Wearables.configure()`.
  static func enableIfRequested() {
    guard isRequested, !MockDeviceKit.shared.isEnabled else { return }
    MockDeviceKit.shared.enable(config: MockDeviceKitConfig(initiallyRegistered: true, initialPermissionsGranted: true))
  }

  @MainActor static var glasses: (any MockGlasses)?

  /// A synthetic "rack" photo: labelled shelves and a few readings, so Nemotron has something to read.
  @MainActor static func fixtureURL(label: String) -> URL {
    let size = CGSize(width: 1600, height: 1200)
    let renderer = UIGraphicsImageRenderer(size: size)
    let image = renderer.image { ctx in
      UIColor(white: 0.18, alpha: 1).setFill(); ctx.fill(CGRect(origin: .zero, size: size))
      let shelf = UIColor(white: 0.35, alpha: 1)
      for i in 0..<5 {
        shelf.setFill(); ctx.fill(CGRect(x: 120, y: 140 + CGFloat(i) * 210, width: 1360, height: 18))
        for j in 0..<6 {
          UIColor(hue: CGFloat((i * 6 + j) % 9) / 9, saturation: 0.5, brightness: 0.7, alpha: 1).setFill()
          ctx.fill(CGRect(x: 140 + CGFloat(j) * 225, y: 160 + CGFloat(i) * 210, width: 200, height: 170))
        }
      }
      let attrs: [NSAttributedString.Key: Any] = [.font: UIFont.monospacedSystemFont(ofSize: 64, weight: .bold), .foregroundColor: UIColor.white]
      NSAttributedString(string: label, attributes: attrs).draw(at: CGPoint(x: 120, y: 40))
      let small: [NSAttributedString.Key: Any] = [.font: UIFont.monospacedSystemFont(ofSize: 40, weight: .semibold), .foregroundColor: UIColor.yellow]
      NSAttributedString(string: "TEMP 23.4C  HUM 41%  \(Date().formatted(date: .omitted, time: .standard))", attributes: small)
        .draw(at: CGPoint(x: 120, y: 1120))
    }
    let url = FileManager.default.temporaryDirectory.appending(path: "mock-\(UUID().uuidString.prefix(8)).jpg")
    try? image.jpegData(compressionQuality: 0.9)?.write(to: url)
    return url
  }
}

struct DebugMenuView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @AppStorage(DebugMock.flagKey) private var mockRequested = false
  @State private var battery = 80.0
  @State private var fixtureLabel = "RACK-07"
  @State private var message: String?

  private var enabled: Bool { MockDeviceKit.shared.isEnabled }

  var body: some View {
    NavigationStack {
      Form {
        Section {
          Toggle("Mock glasses on next launch", isOn: $mockRequested)
          LabeledContent("MockDeviceKit", value: enabled ? "enabled" : "off (relaunch)")
          LabeledContent("Paired mock devices", value: "\(MockDeviceKit.shared.pairedDevices.count)")
        } footer: {
          Text("MockDeviceKit must be enabled before the toolkit configures, so toggling takes effect after you relaunch the app. Launch argument -mockGlasses works too.")
        }

        Section("Device") {
          Button("Pair Ray-Ban Meta") { pair() }.disabled(!enabled || DebugMock.glasses != nil)
          Button("Power on · unfold · don") { wake() }.disabled(DebugMock.glasses == nil)
          HStack {
            Text("Battery \(Int(battery))%")
            Slider(value: $battery, in: 0...100, step: 5) { _ in DebugMock.glasses?.setBatteryLevel(Int(battery)) }
          }.disabled(DebugMock.glasses == nil)
          Button("Fold (pauses session)") { DebugMock.glasses?.fold() }.disabled(DebugMock.glasses == nil)
          Button("Unfold") { DebugMock.glasses?.unfold() }.disabled(DebugMock.glasses == nil)
        }

        Section("Photos") {
          TextField("Fixture label", text: $fixtureLabel).textInputAutocapitalization(.characters).autocorrectionDisabled()
          Button("Load rack fixture as the next photo") { loadFixture() }.disabled(DebugMock.glasses == nil)
          Button("Simulate shutter press") {
            loadFixture()
            model.glasses.debugSimulateShutterPress()
          }.disabled(DebugMock.glasses == nil || !model.glasses.isSessionLive)
          Button("Simulate capture failure") {
            DebugMock.glasses?.services.cameraCapture.simulateCaptureFailure()
          }.disabled(DebugMock.glasses == nil)
        }

        if let message { Section { Text(message).font(.footnote).foregroundStyle(Theme.ink3) } }
      }
      .navigationTitle("Mock glasses")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
    }
  }

  private func pair() {
    do {
      let g = try MockDeviceKit.shared.pairGlasses(model: .rayBanMeta)
      DebugMock.glasses = g
      message = "Paired \(g.deviceIdentifier). Power on, then Start shift on the home screen."
    } catch {
      message = "pairGlasses failed: \(error)"
    }
  }

  private func wake() {
    guard let g = DebugMock.glasses else { return }
    g.powerOn(); g.unfold(); g.don(); g.setBatteryLevel(Int(battery))
    message = "Mock glasses awake and worn."
  }

  private func loadFixture() {
    guard let g = DebugMock.glasses else { return }
    let url = DebugMock.fixtureURL(label: fixtureLabel)
    g.services.cameraCapture.setCapturedPhoto(fileURL: url)
    message = "Next capture returns \(url.lastPathComponent)."
  }
}
#endif
