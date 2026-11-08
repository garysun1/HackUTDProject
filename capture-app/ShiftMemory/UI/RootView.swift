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
          case .floor:
            FloorView(
              store: model.floor,
              onFixWithPhoto: { asset, issue in
                model.fixWithPhoto(asset: asset, issue: issue)
                if !path.isEmpty { path.removeLast() }
              },
              onOpenEvent: { id in path.append(Route.event(id)) }
            )
            .navigationTitle("Floor")
            .navigationBarTitleDisplayMode(.inline)
          }
        }
    }
    .tint(Theme.accent)
    .task {
      await model.start()
      #if DEBUG
      // Screenshot / QA shortcuts: `-openFloor`, `-openBriefing`.
      let args = ProcessInfo.processInfo.arguments
      if args.contains("-openFloor") { path.append(Route.floor) }
      if args.contains("-openBriefing") { model.presentBriefing(.review) }
      #endif
    }
  }
}

enum Route: Hashable {
  case settings
  case diagnostics
  case event(String)
  case floor
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
        if let notice = model.notice {
          NoticeBanner(text: notice) { model.notice = nil }
        }
        GlassesCard()
        ShiftCard(path: $path)
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
    .sheet(isPresented: Binding(get: { model.briefingPresented }, set: { model.briefingPresented = $0 })) {
      NavigationStack {
        BriefingView(
          briefing: model.briefing,
          isLoading: model.briefingLoading,
          error: model.briefingError,
          speaker: model.speaker,
          onRefresh: { Task { await model.loadBriefing() } },
          onOpenEvent: { id in
            model.briefingPresented = false
            path.append(Route.event(id))
          },
          onAcknowledge: { model.acknowledgeBriefing() },
          onSkip: { model.skipBriefing() },
          primaryTitle: model.briefingMode == .shiftStart ? "I'm up to speed, start shift" : "Got it"
        )
      }
      .interactiveDismissDisabled(model.briefingMode == .shiftStart)
    }
    .confirmationDialog("End the shift", isPresented: Binding(get: { model.endShiftPresented }, set: { model.endShiftPresented = $0 }), titleVisibility: .visible) {
      // A handoff is a closing photo, so it needs a live glasses session.
      if model.glasses.isSessionLive {
        Button("Record a handoff, then end") { model.recordHandoff() }
      }
      Button("End without a handoff", role: .destructive) { model.endShiftWithoutHandoff() }
      Button("Keep working", role: .cancel) {}
    } message: {
      Text("Take one closing photo and say what the next person needs to know. They hear it in their briefing.")
    }
  }
}

/// A dismissible one-line instruction ("Press the shutter at PDU A…").
struct NoticeBanner: View {
  let text: String
  let onDismiss: () -> Void
  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: "info.circle.fill").foregroundStyle(Theme.accent)
      Text(text).font(.subheadline).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
      Button(action: onDismiss) { Image(systemName: "xmark").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink3) }
        .frame(minWidth: 44, minHeight: 44)
        .accessibilityLabel("Dismiss")
    }
    .padding(.leading, 12)
    .background(Theme.ground, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).stroke(Theme.line, lineWidth: Theme.hairline))
  }
}

// MARK: - Shift (briefing + floor)

/// Where the shift stands on the shared floor: open issues, the briefing, the map.
struct ShiftCard: View {
  @Environment(AppModel.self) private var model
  @Binding var path: NavigationPath

  var body: some View {
    let open = model.floor.snapshot.openIssues
    Surface {
      VStack(alignment: .leading, spacing: 10) {
        PanelHead(title: "Shift", trailing: model.config.lastBriefingAckAt.map { "briefed \($0.formatted(date: .omitted, time: .shortened))" } ?? "not briefed")
        HStack(spacing: 10) {
          Image(systemName: open.isEmpty ? "checkmark.seal.fill" : "flame.fill")
            .font(.title3)
            .foregroundStyle(open.isEmpty ? Theme.good : Theme.critical)
            .accessibilityHidden(true)
          VStack(alignment: .leading, spacing: 2) {
            Text(open.isEmpty ? "Nothing open on the floor" : "\(open.count) open issue\(open.count == 1 ? "" : "s") on the floor")
              .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            if let first = open.first {
              Text("\(first.entityName): \(first.text)").font(.footnote).foregroundStyle(Theme.ink3).lineLimit(1)
            }
          }
          Spacer(minLength: 0)
        }
        if model.config.locationEnabled {
          LocationLine()
        }
        HStack(spacing: 8) {
          Button { model.presentBriefing(.review) } label: {
            Label("Briefing", systemImage: "text.bubble").frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(InkButtonStyle(prominent: false))
          Button { path.append(Route.floor) } label: {
            Label("Floor map", systemImage: "square.grid.3x3.topleft.filled").frame(maxWidth: .infinity, minHeight: 44)
          }
          .buttonStyle(InkButtonStyle(prominent: false))
        }
      }
    }
    .task {
      // Keep the count on Home current without a full poll loop.
      while !Task.isCancelled {
        await model.floor.refresh()
        try? await Task.sleep(for: .seconds(20))
      }
    }
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
      if model.isShiftOpen {
        Button("End shift") { model.requestEndShift() }.buttonStyle(InkButtonStyle(prominent: false))
      }
    case .deviceAvailable, .stopped:
      if model.isShiftOpen {
        // The glasses session dropped but the shift (and its track) is still open.
        HStack(spacing: 8) {
          Button("Resume shift") { model.beginShift() }.buttonStyle(InkButtonStyle())
          Button("End shift") { model.requestEndShift() }.buttonStyle(InkButtonStyle(prominent: false))
        }
      } else {
        Button("Start shift") { model.beginShift() }.buttonStyle(InkButtonStyle())
      }
    case .starting:
      Button("Starting camera…") {}.buttonStyle(InkButtonStyle()).disabled(true)
    case .ready, .capturing, .paused:
      Button("End shift") { model.requestEndShift() }.buttonStyle(InkButtonStyle(prominent: false))
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

        NarrationBanner(narrator: model.narrator)

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

/// One quiet line under the shift: is the phone placing photos and tracking the walk?
struct LocationLine: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    let loc = model.location
    HStack(spacing: 6) {
      Image(systemName: loc.mode == .shift ? "location.fill" : "location")
        .foregroundStyle(loc.latest == nil ? Theme.ink4 : Theme.accent)
        .accessibilityHidden(true)
      Text(text(loc)).font(Theme.mono(11)).foregroundStyle(Theme.ink3).lineLimit(1)
    }
    .accessibilityElement(children: .combine)
  }

  private func text(_ loc: LocationTracker) -> String {
    switch loc.authorization {
    case .denied, .restricted: return "Location off in iOS Settings; photos are not placed"
    case .notDetermined: return "Location not allowed yet (Settings › Location)"
    default: break
    }
    let fix = loc.latest.map { "±\(Int($0.accuracyM.rounded())) m" } ?? "waiting for a fix"
    switch loc.mode {
    case .shift: return "Tracking this shift · \(fix) · \(loc.keptPoints) points"
    case .foreground: return "Placing photos · \(fix)"
    case .off: return "Location off"
    }
  }
}
