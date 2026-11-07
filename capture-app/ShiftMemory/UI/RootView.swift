//
// RootView.swift
// Shift Memory
//
// One NavigationStack. Home is the shift: glasses state, the Capture button, the recent events.
// Settings, event detail and diagnostics are pushed; the DEBUG menu is a sheet.
//

import SwiftUI
import PhotosUI

struct RootView: View {
  @Environment(AppModel.self) private var model
  @State private var path = NavigationPath()

  var body: some View {
    NavigationStack(path: $path) {
      HomeView(path: $path)
        .navigationDestination(for: Route.self) { route in
          switch route {
          case .settings: SettingsView()
          case .diagnostics: DiagnosticsView()
          case .event(let id): EventDetailView(eventId: id)
          }
        }
    }
    .tint(Theme.accent)
    .task { await model.start() }
  }
}

enum Route: Hashable {
  case settings
  case diagnostics
  case event(String)
}

// MARK: - Home

struct HomeView: View {
  @Environment(AppModel.self) private var model
  @Binding var path: NavigationPath
  @State private var pickerItem: PhotosPickerItem?
  @State private var showDebug = false

  var body: some View {
    ScrollView {
      VStack(spacing: 12) {
        GlassesCard()
        CaptureCard()
        PendingBanner()
        RecentEventsCard(path: $path)
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .background(Theme.page)
    .navigationTitle("Shift Memory")
    .navigationBarTitleDisplayMode(.large)
    .toolbar {
      ToolbarItem(placement: .topBarLeading) { BackendPill() }
      ToolbarItem(placement: .topBarTrailing) {
        Menu {
          NavigationLink(value: Route.settings) { Label("Settings", systemImage: "gearshape") }
          NavigationLink(value: Route.diagnostics) { Label("Diagnostics", systemImage: "waveform.path.ecg") }
          PhotosPicker(selection: $pickerItem, matching: .images) {
            Label("Upload a photo…", systemImage: "square.and.arrow.up")
          }
          #if DEBUG
          Divider()
          Button { showDebug = true } label: { Label("Mock glasses…", systemImage: "hammer") }
          #endif
        } label: {
          Image(systemName: "ellipsis.circle").accessibilityLabel("More")
        }
      }
    }
    .onChange(of: pickerItem) { _, item in
      guard let item else { return }
      Task {
        if let data = try? await item.loadTransferable(type: Data.self) { await model.importPicked(data) }
        pickerItem = nil
      }
    }
    #if DEBUG
    .sheet(isPresented: $showDebug) { DebugMenuView() }
    #endif
  }
}

/// Backend reachability in two words: host and a dot.
struct BackendPill: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    let reachable = model.store.backendReachable
    let tone: StatusPill.Tone = reachable == true ? .good : (reachable == false ? .critical : .neutral)
    let text = model.config.isBackendConfigured ? model.config.database : "no backend"
    StatusPill(text: text, tone: tone, systemImage: reachable == true ? "dot.radiowaves.left.and.right" : "bolt.horizontal")
      .accessibilityLabel("Backend \(text) \(reachable == true ? "reachable" : "unreachable")")
  }
}

// MARK: - Glasses

struct GlassesCard: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let g = model.glasses
    Surface {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline) {
          Label(g.deviceName ?? "Meta glasses", systemImage: "eyeglasses")
            .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            .lineLimit(1)
          Spacer()
          if let battery = g.deviceBattery {
            Label("\(battery)%", systemImage: batterySymbol(battery))
              .font(Theme.mono(12)).foregroundStyle(Theme.ink3)
              .accessibilityLabel("Glasses battery \(battery) percent")
          }
          PhasePill(phase: g.phase)
        }
        if let error = g.lastError {
          Text(error).font(.footnote).foregroundStyle(Theme.criticalInk).fixedSize(horizontal: false, vertical: true)
        } else {
          Text(hint(for: g.phase)).font(.footnote).foregroundStyle(Theme.ink3).fixedSize(horizontal: false, vertical: true)
        }
        if g.needsFirmwareUpdate {
          Button("Update glasses firmware in Meta AI") { Task { await g.openFirmwareUpdate() } }
            .buttonStyle(InkButtonStyle(prominent: false))
        } else if g.needsGlassesAppUpdate {
          Button("Update the glasses app in Meta AI") { Task { await g.openGlassesAppUpdate() } }
            .buttonStyle(InkButtonStyle(prominent: false))
        } else {
          primaryAction(for: g.phase)
        }
      }
    }
  }

  @ViewBuilder
  private func primaryAction(for phase: GlassesController.Phase) -> some View {
    let g = model.glasses
    switch phase {
    case .notRegistered, .unavailable:
      Button("Connect to Meta AI") { Task { await g.connect() } }.buttonStyle(InkButtonStyle())
    case .registering:
      Button("Connecting…") {}.buttonStyle(InkButtonStyle()).disabled(true)
    case .noDevice:
      Button("Looking for glasses…") { Task { await g.refreshPermission() } }
        .buttonStyle(InkButtonStyle(prominent: false))
    case .deviceAvailable, .stopped:
      Button("Start shift") { Task { await g.startShift() } }.buttonStyle(InkButtonStyle())
    case .starting:
      Button("Starting camera…") {}.buttonStyle(InkButtonStyle()).disabled(true)
    case .ready, .capturing, .paused:
      Button("End shift") { g.endShift(reason: "ended by operator") }.buttonStyle(InkButtonStyle(prominent: false))
    }
  }

  private func hint(for phase: GlassesController.Phase) -> String {
    switch phase {
    case .unavailable(let why): "Glasses toolkit unavailable: \(why)"
    case .notRegistered: "Register this app with Meta AI once. The glasses stay paired to Meta AI; Shift Memory only receives photos."
    case .registering: "Finishing registration in Meta AI…"
    case .noDevice: "No glasses are connected to Meta AI. Open the glasses and check Bluetooth."
    case .deviceAvailable: "Glasses found. Start the shift to open the camera so shutter-button photos arrive here."
    case .starting: "Opening the session and the camera. Startup is the step most likely to fail; it retries once."
    case .ready: "Press the glasses’ shutter or tap Capture. Each photo becomes one event."
    case .capturing: "Transferring the photo from the glasses…"
    case .paused: "Session paused by the glasses (folded, doffed or busy). It resumes on its own."
    case .stopped: model.glasses.stopReason.map { "Session stopped: \($0)" } ?? "Session stopped."
    }
  }

  private func batterySymbol(_ level: Int) -> String {
    switch level {
    case ..<10: "battery.0percent"
    case ..<40: "battery.25percent"
    case ..<65: "battery.50percent"
    case ..<90: "battery.75percent"
    default: "battery.100percent"
    }
  }
}

struct PhasePill: View {
  let phase: GlassesController.Phase
  var body: some View {
    switch phase {
    case .unavailable: StatusPill(text: "unavailable", tone: .critical)
    case .notRegistered: StatusPill(text: "not registered", tone: .neutral)
    case .registering: StatusPill(text: "registering", tone: .pending)
    case .noDevice: StatusPill(text: "no glasses", tone: .neutral)
    case .deviceAvailable: StatusPill(text: "paired", tone: .neutral)
    case .starting: StatusPill(text: "starting", tone: .pending)
    case .ready: StatusPill(text: "live", tone: .good)
    case .capturing: StatusPill(text: "capturing", tone: .pending)
    case .paused: StatusPill(text: "paused", tone: .pending)
    case .stopped: StatusPill(text: "stopped", tone: .neutral)
    }
  }
}

// MARK: - Capture

struct CaptureCard: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    @Bindable var config = model.config
    let g = model.glasses
    Surface {
      VStack(alignment: .leading, spacing: 10) {
        PanelHead(title: "Capture", trailing: "\(config.captureResolution) · \(config.captureQuality)")
        Button {
          model.capture()
        } label: {
          Label(g.phase == .capturing ? "Transferring…" : "Capture", systemImage: "camera.fill")
            .frame(minHeight: 56)
        }
        .buttonStyle(InkButtonStyle())
        .disabled(g.phase != .ready)
        .accessibilityHint("Takes one photo with the glasses and uploads it as an event")

        if g.phase == .capturing {
          ProgressView(value: g.transferFraction ?? 0)
            .tint(Theme.accent)
          HStack {
            Text(transferText(g)).font(Theme.mono(11)).foregroundStyle(Theme.ink3)
            Spacer()
          }
        }

        VStack(spacing: 8) {
          TextField("Label (optional, e.g. rack-07)", text: $config.pendingLabel)
            .textInputAutocapitalization(.never).autocorrectionDisabled()
          Divider()
          TextField("Note for the next photo (optional)", text: $config.pendingNote, axis: .vertical)
            .lineLimit(1...3)
        }
        .font(.subheadline)
        .padding(10)
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
      }
    }
  }

  private func transferText(_ g: GlassesController) -> String {
    if let bytes = g.transferBytes, bytes.total > 0 {
      return "\(bytes.received / 1024) / \(bytes.total / 1024) KB"
    }
    return g.transferFraction.map { "\(Int($0 * 100))%" } ?? "waiting for the glasses"
  }
}

// MARK: - Pending uploads

struct PendingBanner: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    let pending = model.store.pendingCount
    let failed = model.store.events.filter { $0.stage == .failed && $0.lastError != nil && !$0.lastError!.contains("module") }.count
    if pending > 0 || failed > 0 {
      HStack(spacing: 10) {
        Image(systemName: model.isOnline ? "arrow.up.circle" : "wifi.slash")
          .foregroundStyle(Theme.warningInk)
        VStack(alignment: .leading, spacing: 2) {
          Text(pending > 0 ? "\(pending) upload\(pending == 1 ? "" : "s") pending" : "\(failed) upload\(failed == 1 ? "" : "s") failed")
            .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
          Text(model.isOnline ? (model.store.lastBackendError ?? "Retrying with backoff.") : "Offline. Photos are saved and will send when the network is back.")
            .font(.footnote).foregroundStyle(Theme.ink3).lineLimit(2)
        }
        Spacer()
        Button("Retry") { Task { await model.queue.kick(); await model.ping() } }
          .font(.subheadline.weight(.semibold))
          .frame(minHeight: 44)
      }
      .padding(12)
      .background(Theme.warningBg, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }
  }
}

// MARK: - Recent events

struct RecentEventsCard: View {
  @Environment(AppModel.self) private var model
  @Binding var path: NavigationPath

  var body: some View {
    Surface(padding: 0) {
      VStack(alignment: .leading, spacing: 0) {
        PanelHead(title: "Recent events", trailing: model.store.events.isEmpty ? nil : "\(model.store.events.count)")
          .padding(14)
        if model.store.events.isEmpty {
          VStack(spacing: 6) {
            Image(systemName: "photo.on.rectangle.angled").font(.title2).foregroundStyle(Theme.ink4)
            Text("No photos yet").font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink2)
            Text("Start the shift and press the shutter on the glasses.").font(.footnote).foregroundStyle(Theme.ink3)
              .multilineTextAlignment(.center)
          }
          .frame(maxWidth: .infinity).padding(.vertical, 28).padding(.horizontal, 14)
        } else {
          ForEach(model.store.events.prefix(50)) { event in
            Divider().overlay(Theme.lineSoft)
            Button { path.append(Route.event(event.id)) } label: { EventRow(event: event) }
              .buttonStyle(.plain)
          }
        }
      }
    }
  }
}

struct EventRow: View {
  @Environment(AppModel.self) private var model
  let event: CaptureEvent

  var body: some View {
    HStack(spacing: 12) {
      Group {
        if let thumb = model.store.thumbnail(for: event.id) {
          Image(uiImage: thumb).resizable().scaledToFill()
        } else {
          Theme.panel
        }
      }
      .frame(width: 56, height: 56)
      .clipShape(RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
      .accessibilityHidden(true)

      VStack(alignment: .leading, spacing: 3) {
        HStack(spacing: 6) {
          Image(systemName: event.source.systemImage).font(.caption).foregroundStyle(Theme.ink3)
            .accessibilityLabel(event.source.label)
          Text(event.clientT, format: .dateTime.hour().minute().second())
            .font(Theme.mono(12)).foregroundStyle(Theme.ink2)
          if let label = event.label, !label.isEmpty {
            Text(label).font(.caption.weight(.medium)).foregroundStyle(Theme.entity).lineLimit(1)
          }
          Spacer()
          StagePill(stage: event.stage)
        }
        Text(summaryText).font(.footnote).foregroundStyle(summaryColor).lineLimit(2)
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .contentShape(Rectangle())
  }

  private var summaryText: String {
    if let s = event.summary, !s.isEmpty { return s }
    switch event.stage {
    case .processing: return "Preparing the photo…"
    case .queued: return event.lastError ?? "Waiting to upload"
    case .uploading: return "Uploading…"
    case .accepted: return "Reading the photo…"
    case .inGraph: return "In the graph"
    case .duplicate: return "Already in the graph"
    case .failed: return event.lastError ?? "Failed"
    }
  }
  private var summaryColor: Color { event.stage == .failed ? Theme.criticalInk : Theme.ink3 }
}

struct StagePill: View {
  let stage: EventStage
  var body: some View {
    switch stage {
    case .processing, .queued, .uploading, .accepted: StatusPill(text: stage.label, tone: .pending)
    case .inGraph: StatusPill(text: stage.label, tone: .good)
    case .duplicate: StatusPill(text: stage.label, tone: .neutral)
    case .failed: StatusPill(text: stage.label, tone: .critical)
    }
  }
}
