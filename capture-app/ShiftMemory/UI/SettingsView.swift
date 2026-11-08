//
// SettingsView.swift
// Shift Memory
//
// Grouped list, system controls. The ingest token lives in the Keychain and is never echoed back
// in full; the device id is what Gary seeds into demo/wearers.csv, so it gets a copy button.
//

import SwiftUI

struct SettingsView: View {
  @Environment(AppModel.self) private var model
  @State private var testing = false
  @State private var copied = false

  var body: some View {
    @Bindable var config = model.config
    let store = model.store
    Form {
      Section {
        LabeledContent("Host") {
          TextField("https://maincloud.spacetimedb.com", text: $config.host)
            .multilineTextAlignment(.trailing).keyboardType(.URL)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
        }
        LabeledContent("Database") {
          TextField("wm-physical", text: $config.database)
            .multilineTextAlignment(.trailing).textInputAutocapitalization(.never).autocorrectionDisabled()
        }
        SecureField("Ingest token", text: $config.ingestToken)
          .textInputAutocapitalization(.never).autocorrectionDisabled()
        Button {
          testing = true
          Task { await model.ping(); testing = false }
        } label: {
          HStack {
            Text(testing ? "Testing…" : "Test connection")
            Spacer()
            if let reachable = store.backendReachable {
              if reachable, let ping = store.lastPing {
                Text("\(ping.roundTripMs) ms · offset \(ping.clockOffsetMs) ms").font(Theme.mono(12)).foregroundStyle(Theme.goodInk)
              } else {
                Text("unreachable").font(.footnote).foregroundStyle(Theme.criticalInk)
              }
            }
          }
        }
        .disabled(testing || !config.isBackendConfigured)
        if let error = store.lastBackendError, store.backendReachable == false {
          Text(error).font(.footnote).foregroundStyle(Theme.criticalInk)
        }
      } header: {
        Text("Backend")
      } footer: {
        Text(config.hasIngestToken ? "Token stored in the Keychain." : "No ingest token yet. Uploads will be rejected with “invalid token” until one is set.")
      }

      Section {
        TextField("Wearer name", text: $config.wearerName)
        LabeledContent("Device ID") {
          HStack(spacing: 8) {
            Text(config.deviceId).font(Theme.mono(13)).foregroundStyle(Theme.ink2).lineLimit(1).truncationMode(.middle)
            Button {
              UIPasteboard.general.string = config.deviceId
              copied = true
              Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
            } label: {
              Image(systemName: copied ? "checkmark" : "doc.on.doc")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Copy device ID")
          }
        }
      } header: {
        Text("Identity")
      } footer: {
        Text("Every event carries this device id; the backend maps it to a wearer and shift.")
      }

      Section("Capture") {
        Picker("Resolution", selection: $config.captureResolution) {
          Text("Full").tag("full"); Text("Large").tag("large"); Text("Medium").tag("medium"); Text("Small").tag("small")
        }
        Picker("Quality", selection: $config.captureQuality) {
          Text("High").tag("high"); Text("Medium").tag("medium"); Text("Low").tag("low")
        }
        Toggle("Blur faces before upload", isOn: $config.blurFaces)
        Toggle("Keep session alive in background", isOn: $config.keepSessionInBackground)
        Toggle("Shutter sound", isOn: $config.shutterSound)
      }

      LocationSection()

      Section {
        Toggle("Listen after each photo", isOn: $config.voiceContext)
        Toggle("Use the glasses' microphone", isOn: $config.useGlassesMic)
          .disabled(!config.voiceContext)
        Toggle("Briefing before each shift", isOn: $config.briefingOnStart)
      } header: {
        Text("Voice and briefing")
      } footer: {
        Text("After the chime, say what is going on: what you see, what you changed, why. It is transcribed on this iPhone and sent as the photo's note, which the backend reads with the image. No audio leaves the phone.")
      }

      Section {
        Toggle("Import from camera roll", isOn: Binding(
          get: { config.cameraRollImportEnabled },
          set: { on in Task { await model.setCameraRollImport(enabled: on) } }
        ))
        if config.cameraRollImportEnabled {
          Toggle("Only glasses photos", isOn: $config.cameraRollOnlyGlassesPhotos)
            .onChange(of: config.cameraRollOnlyGlassesPhotos) { _, v in model.importer.onlyGlassesPhotos = v }
          Button(model.importer.isScanning ? "Scanning…" : "Scan now") { Task { await model.importer.scanNow() } }
            .disabled(model.importer.isScanning)
          LabeledContent("Imported", value: "\(model.importer.importedCount) · skipped \(model.importer.skippedCount)")
          if let at = model.importer.lastScanAt {
            LabeledContent("Last scan", value: at.formatted(.dateTime.hour().minute()))
          }
          if model.importer.authorization == .denied {
            Text("Photos access denied. Allow it in iOS Settings › Shift Memory.").font(.footnote).foregroundStyle(Theme.criticalInk)
          }
          if let e = model.importer.lastError { Text(e).font(.footnote).foregroundStyle(Theme.criticalInk) }
        }
      } header: {
        Text("Camera-roll import")
      } footer: {
        Text("Fallback when shutter photos do not reach the app in the background: Meta AI saves them to Photos, and new ones are uploaded with their original timestamps.")
      }

      Section("Diagnostics") {
        NavigationLink(value: Route.diagnostics) {
          LabeledContent("Measurements", value: "\(model.diagnostics.summary.captureCount) captures")
        }
      }

      Section("About") {
        LabeledContent("Version", value: config.appVersion)
        LabeledContent("Glasses toolkit", value: "Meta Wearables DAT 1.0.1")
        LabeledContent("Contract", value: "phone → Spacetime v3")
      }
    }
    .scrollContentBackground(.hidden)
    .background(Theme.page)
    .navigationTitle("Settings")
    .navigationBarTitleDisplayMode(.inline)
    .onChange(of: config.host) { _, _ in store.backendReachable = nil }
    .onChange(of: config.database) { _, _ in store.backendReachable = nil }
  }
}

// MARK: - Location (#19)

/// Location on/off, what the phone currently knows, whether the backend takes the track yet, and the
/// GeoJSON export of the shift (track + photo pins) for the console or a map tool.
struct LocationSection: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openURL) private var openURL
  @State private var exportURL: URL?
  @State private var exporting = false
  @State private var pendingPoints = 0
  @State private var recordedPoints = 0

  var body: some View {
    let loc = model.location
    let up = model.trackUploader
    Section {
      Toggle("Share location", isOn: Binding(get: { model.config.locationEnabled }, set: { model.setLocationEnabled($0) }))
      if model.config.locationEnabled {
        LabeledContent("Permission", value: permissionText(loc.authorization, precise: loc.isPrecise))
        if loc.authorization == .notDetermined {
          Button("Allow location") { loc.requestAuthorization() }
        } else if loc.authorization == .denied || loc.authorization == .restricted || !loc.isPrecise {
          Button("Open iOS Settings") {
            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
          }
        }
        if let fix = loc.latest {
          LabeledContent("Last fix") {
            Text("±\(Int(fix.accuracyM.rounded())) m · \(fix.t.formatted(date: .omitted, time: .standard))")
              .font(Theme.mono(12)).foregroundStyle(fix.accuracyM <= 50 ? Theme.ink2 : Theme.warningInk)
          }
        } else {
          LabeledContent("Last fix", value: "none yet")
        }
        LabeledContent("Mode", value: modeText(loc.mode))
        LabeledContent("Track this shift", value: "\(recordedPoints) points · \(pendingPoints) waiting")
        LabeledContent("Backend", value: supportText(up.support))
        if let error = loc.lastError ?? up.lastError {
          Text(error).font(.footnote).foregroundStyle(Theme.criticalInk)
        }
        if let exportURL {
          ShareLink(item: exportURL) { Label("Share shift track (GeoJSON)", systemImage: "square.and.arrow.up") }
          Button("Refresh export") { self.exportURL = nil }
            .font(.footnote)
        } else {
          Button(exporting ? "Preparing…" : "Export shift track (GeoJSON)") {
            exporting = true
            Task {
              exportURL = await model.exportTrackGeoJSON()
              exporting = false
            }
          }
          .disabled(exporting)
        }
      }
    } header: {
      Text("Location")
    } footer: {
      Text("Each photo carries where it was taken. While a shift is running the phone also records the path you walk, including in your pocket, so the console can show the shift on a map. Nothing is recorded between shifts.")
    }
    .task(id: model.config.activeShiftId) {
      exportURL = nil   // a different shift: export again
      while !Task.isCancelled {
        pendingPoints = await model.trackStore.pendingCount()
        if let id = model.config.activeShiftId { recordedPoints = await model.trackStore.recordedCount(shiftId: id) } else { recordedPoints = 0 }
        try? await Task.sleep(for: .seconds(3))
      }
    }
  }

  private func permissionText(_ a: LocationTracker.Authorization, precise: Bool) -> String {
    switch a {
    case .notDetermined: "not asked yet"
    case .restricted: "restricted"
    case .denied: "denied"
    case .whenInUse: precise ? "while using (precise)" : "while using (approximate)"
    case .always: precise ? "always (precise)" : "always (approximate)"
    }
  }

  private func modeText(_ m: LocationTracker.Mode) -> String {
    switch m {
    case .off: "off"
    case .foreground: "photos only (no shift)"
    case .shift: "tracking the shift"
    }
  }

  private func supportText(_ s: TrackUploader.Support) -> String {
    switch s {
    case .unknown: "checking…"
    case .supported: "receiving the track"
    case .unsupported: "track not stored yet (#20); buffering"
    case .unreachable(let why): "unreachable: \(why)"
    }
  }
}
