//
// BriefingView.swift
// Shift Memory
//
// The shift-start sheet: one honest headline, the handoff text if the module generated one, then
// what needs you (each item checked off with "Got it"), what the previous people said, what changed,
// and which assets went unseen. The primary button only enables once every open issue is checked
// off, so starting a shift means you saw every problem. "Read it to me" stays pinned at the bottom
// so it works while scrolling. All state except the check marks belongs to the caller.
//

import SwiftUI

struct BriefingView: View {
  let briefing: Briefing?
  let isLoading: Bool
  let error: String?
  let speaker: BriefingSpeaker
  /// The automated read-and-repeat-back check; nil when it is off.
  let check: BriefingCheck?
  let onListenAgain: () -> Void
  let onRerunCheck: () -> Void
  let onRefresh: () -> Void
  let onOpenEvent: (String) -> Void
  let onAcknowledge: () -> Void
  let onSkip: () -> Void
  var primaryTitle: String = "I'm up to speed, start shift"

  @State private var acknowledged: Set<String> = []
  @State private var showQuiet = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @ScaledMetric(relativeTo: .caption) private var monoSize: CGFloat = 12

  init(briefing: Briefing?, isLoading: Bool, error: String?, speaker: BriefingSpeaker, check: BriefingCheck? = nil,
       onListenAgain: @escaping () -> Void = {}, onRerunCheck: @escaping () -> Void = {},
       onRefresh: @escaping () -> Void, onOpenEvent: @escaping (String) -> Void,
       onAcknowledge: @escaping () -> Void, onSkip: @escaping () -> Void,
       primaryTitle: String = "I'm up to speed, start shift") {
    self.briefing = briefing
    self.isLoading = isLoading
    self.error = error
    self.speaker = speaker
    self.check = check
    self.onListenAgain = onListenAgain
    self.onRerunCheck = onRerunCheck
    self.onRefresh = onRefresh
    self.onOpenEvent = onOpenEvent
    self.onAcknowledge = onAcknowledge
    self.onSkip = onSkip
    self.primaryTitle = primaryTitle
  }

  var body: some View {
    NavigationStack {
      content
        .background(Theme.page)
        .navigationTitle("Shift briefing")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
          if briefing == nil {
            ToolbarItem(placement: .topBarLeading) {
              Button("Skip") { speaker.stop(); onSkip() }
                .accessibilityHint("Start without the briefing")
            }
          }
          ToolbarItem(placement: .topBarTrailing) {
            Button { onRefresh() } label: { Image(systemName: "arrow.clockwise") }
              .disabled(isLoading)
              .accessibilityLabel("Refresh briefing")
          }
        }
    }
    .tint(Theme.accent)
    // Always explicit: a swipe-down would close the sheet without calling onAcknowledge or onSkip,
    // leaving the caller's start-shift flow waiting. Skip is always on screen instead.
    .interactiveDismissDisabled(true)
    .onDisappear { speaker.stop() }
    .onChange(of: briefing?.needsYou.map(\.id) ?? []) { _, ids in
      acknowledged.formIntersection(ids)
    }
    .onChange(of: check?.phase) { _, phase in
      // A pass is the acknowledgement: every open item is checked, and the caller closes the sheet.
      if phase == .passed, let briefing { acknowledged.formUnion(briefing.needsYou.map(\.id)) }
    }
  }

  // MARK: - Spoken check

  private func checkCard(_ check: BriefingCheck, _ b: Briefing) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 8) {
        checkIcon(check.phase)
        Text(checkTitle(check.phase)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
          .fixedSize(horizontal: false, vertical: true)
        Spacer(minLength: 0)
        if check.phase.isActive {
          Button("Stop") { check.cancel() }.font(.footnote).foregroundStyle(Theme.ink3)
        }
      }
      if check.phase == .listening {
        Text(check.liveTranscript.isEmpty ? "Listening… say “yes” when it makes sense." : check.liveTranscript)
          .font(.body).foregroundStyle(check.liveTranscript.isEmpty ? Theme.ink3 : Theme.ink2)
          .fixedSize(horizontal: false, vertical: true)
      } else if !check.heard.isEmpty, check.phase != .speaking, check.phase != .writing {
        Text("You said: “\(check.heard)”").font(.footnote).foregroundStyle(Theme.ink3)
          .fixedSize(horizontal: false, vertical: true)
      }
      if check.phase == .idle, check.spoken != nil {
        HStack(spacing: 12) {
          Button("Listen again") { onListenAgain() }.buttonStyle(InkButtonStyle(prominent: false))
          Button("Read it again") { onRerunCheck() }.buttonStyle(InkButtonStyle(prominent: false))
        }
        .padding(.top, 4)
      } else if case .unavailable = check.phase {
        Button("Try again") { onRerunCheck() }.buttonStyle(InkButtonStyle(prominent: false)).padding(.top, 4)
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.ground)
    .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
    .clipShape(RoundedRectangle(cornerRadius: 10))
    .accessibilityElement(children: .contain)
  }

  @ViewBuilder
  private func checkIcon(_ phase: BriefingCheck.Phase) -> some View {
    switch phase {
    case .writing: ProgressView().controlSize(.small)
    case .speaking, .reprompting: Image(systemName: "speaker.wave.2.fill").foregroundStyle(Theme.accent)
    case .listening: Image(systemName: "mic.fill").foregroundStyle(Theme.critical)
    case .waiting: Image(systemName: "ellipsis").foregroundStyle(Theme.ink3)
    case .passed: Image(systemName: "checkmark.seal.fill").foregroundStyle(Theme.accent)
    case .unavailable: Image(systemName: "mic.slash").foregroundStyle(Theme.ink3)
    case .idle: Image(systemName: "speaker.slash").foregroundStyle(Theme.ink3)
    }
  }

  private func checkTitle(_ phase: BriefingCheck.Phase) -> String {
    switch phase {
    case .idle: "No answer heard. Check the items off, or ask me to listen again."
    case .writing: "Writing your briefing…"
    case .speaking: "Reading the briefing"
    case .listening: "Does that make sense?"
    case .waiting: "Waiting…"
    case .reprompting: "Asking again"
    case .passed: "Understood. Starting your shift."
    case .unavailable(let why): why
    }
  }

  @ViewBuilder
  private var content: some View {
    if let briefing {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          header(briefing)
          if let check, check.phase != .idle { checkCard(check, briefing) }
          if !briefing.needsYou.isEmpty { needsYouSection(briefing.needsYou) }
          if !briefing.leftForYou.isEmpty { leftForYouSection(briefing.leftForYou) }
          if !briefing.changed.isEmpty { changedSection(briefing.changed) }
          if !briefing.quiet.isEmpty { quietSection(briefing.quiet) }
          if let error {
            Text("Couldn't refresh: \(error)").font(.footnote).foregroundStyle(Theme.criticalInk)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
      }
      .refreshable { onRefresh() }
      .safeAreaInset(edge: .bottom) { bottomBar(briefing) }
    } else if let error, !isLoading {
      ContentUnavailableView {
        Label("Couldn't load the briefing", systemImage: "exclamationmark.triangle")
      } description: {
        Text(error)
      } actions: {
        Button("Try again", action: onRefresh).buttonStyle(InkButtonStyle()).frame(maxWidth: 240)
        Button("Skip briefing") { onSkip() }.font(.subheadline).frame(minHeight: 44)
      }
    } else {
      VStack(spacing: 12) {
        ProgressView()
        Text("Reading the shared memory…").font(.subheadline).foregroundStyle(Theme.ink3)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity)
      .accessibilityElement(children: .combine)
    }
  }

  // MARK: - Header

  private func header(_ b: Briefing) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("Since \(b.sinceDate.formatted(date: .omitted, time: .shortened))")
        .font(Theme.mono(monoSize)).foregroundStyle(Theme.ink3)
        .accessibilityLabel("Covering since \(b.sinceDate.formatted(date: .omitted, time: .shortened))")
      Text(b.headline)
        .font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityAddTraits(.isHeader)
      if let lead = b.leadText {
        VStack(alignment: .leading, spacing: 4) {
          Text(b.leadGeneratedAt.map { "From the handoff generated at \($0.formatted(date: .omitted, time: .shortened))" }
               ?? "From the handoff")
            .font(.caption.weight(.medium)).foregroundStyle(Theme.ink3)
          Text(lead).font(.body).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 4)
      }
    }
  }

  // MARK: - Needs you

  private func needsYouSection(_ items: [BriefingItem]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      PanelHead(title: "Needs you", trailing: "\(acknowledgedCount(items)) of \(items.count) checked")
      ForEach(items) { item in needsYouCard(item) }
    }
  }

  private func needsYouCard(_ item: BriefingItem) -> some View {
    let done = acknowledged.contains(item.id)
    return HStack(alignment: .top, spacing: 0) {
      Rectangle().fill(color(item.severity)).frame(width: 4)
        .accessibilityHidden(true)
      HStack(alignment: .top, spacing: 10) {
        VStack(alignment: .leading, spacing: 6) {
          Text(item.title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel("\(severityWord(item.severity)): \(item.title)")
          ViewThatFits(in: .horizontal) {
            HStack(spacing: 6) { placeAndWho(item) }
            VStack(alignment: .leading, spacing: 4) { placeAndWho(item) }
          }
          if !item.detail.isEmpty {
            Text(item.detail).font(.footnote).foregroundStyle(Theme.ink2).fixedSize(horizontal: false, vertical: true)
          }
          if let eventId = item.eventId {
            Button { onOpenEvent(eventId) } label: { Label("Open photo", systemImage: "photo") }
              .font(.footnote).frame(minHeight: 44, alignment: .leading)
          }
        }
        Spacer(minLength: 0)
        Button {
          if done { acknowledged.remove(item.id) } else { acknowledged.insert(item.id) }
        } label: {
          VStack(spacing: 2) {
            Image(systemName: done ? "checkmark.circle.fill" : "circle")
              .font(.title2)
              .foregroundStyle(done ? Theme.good : Theme.ink4)
            Text("Got it").font(.caption2.weight(.medium)).foregroundStyle(done ? Theme.goodInk : Theme.ink3)
          }
          .frame(minWidth: 44, minHeight: 44)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(done ? "Got it, checked" : "Got it")
        .accessibilityHint("Marks that you have seen \(item.title)")
        .accessibilityAddTraits(done ? .isSelected : [])
      }
      .padding(12)
    }
    .background(Theme.ground)
    .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
      .strokeBorder(done ? Theme.good.opacity(0.5) : Theme.line, lineWidth: 1))
    .animation(reduceMotion ? nil : .easeOut(duration: 0.15), value: done)
  }

  // MARK: - Left for you

  private func leftForYouSection(_ items: [BriefingItem]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      PanelHead(title: "Left for you", trailing: "\(items.count)")
      Surface {
        VStack(alignment: .leading, spacing: 12) {
          ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
            if index > 0 { Divider().overlay(Theme.lineSoft) }
            Button { if let id = item.eventId { onOpenEvent(id) } } label: {
            HStack(alignment: .top, spacing: 10) {
              Rectangle().fill(item.isHandoffNote ? Theme.accent : Theme.lineStrong).frame(width: 3)
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 4) {
                if item.isHandoffNote {
                  StatusPill(text: "Handoff", tone: .accent, systemImage: "arrow.right.arrow.left")
                }
                Text("“\(item.title)”").font(.body).italic().foregroundStyle(Theme.ink)
                  .fixedSize(horizontal: false, vertical: true)
                whoWhen(item)
                if let place = item.place { Text(place).font(.caption).foregroundStyle(Theme.place) }
              }
              Spacer(minLength: 0)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(item.eventId == nil)
            .accessibilityElement(children: .combine)
            .accessibilityHint(item.eventId == nil ? "" : "Opens the photo")
          }
        }
      }
    }
  }

  // MARK: - What changed

  private func changedSection(_ items: [BriefingItem]) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      PanelHead(title: "What changed", trailing: "\(items.count)")
      Surface {
        VStack(alignment: .leading, spacing: 10) {
          ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
            if index > 0 { Divider().overlay(Theme.lineSoft) }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
              Image(systemName: item.id.hasPrefix("resolved-") ? "checkmark.seal" : "arrow.triangle.2.circlepath")
                .foregroundStyle(item.id.hasPrefix("resolved-") ? Theme.goodInk : color(item.severity))
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 2) {
                Text(item.title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                  .fixedSize(horizontal: false, vertical: true)
                let sub = [item.detail.nilIfEmpty, item.place].compactMap { $0 }.joined(separator: " · ")
                if !sub.isEmpty { Text(sub).font(.footnote).foregroundStyle(Theme.ink3) }
                whoWhen(item)
              }
              Spacer(minLength: 0)
            }
            .accessibilityElement(children: .combine)
          }
        }
      }
    }
  }

  // MARK: - Quiet

  private func quietSection(_ names: [String]) -> some View {
    Surface {
      DisclosureGroup(isExpanded: $showQuiet) {
        VStack(alignment: .leading, spacing: 6) {
          ForEach(names, id: \.self) { name in
            Text(name).font(.footnote).foregroundStyle(Theme.ink2)
          }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 8)
      } label: {
        PanelHead(title: "Quiet", trailing: "\(names.count) not looked at")
          .frame(minHeight: 44)
      }
      .accessibilityHint("Assets nobody photographed since the shift started")
    }
  }

  // MARK: - Bottom bar

  private func bottomBar(_ b: Briefing) -> some View {
    let remaining = b.needsYou.count - acknowledgedCount(b.needsYou)
    return VStack(spacing: 8) {
      Button {
        if let check, check.phase.isActive { check.cancel() }
        else if check != nil { onRerunCheck() }
        else { speaker.isSpeaking ? speaker.stop() : speaker.speak(check?.spoken?.script ?? b.spokenScript) }
      } label: {
        let active = speaker.isSpeaking || check?.phase.isActive == true
        Label(active ? "Stop" : (check == nil ? "Read it to me" : "Read it again and check me"),
              systemImage: active ? "stop.fill" : "speaker.wave.2.fill")
      }
      .buttonStyle(InkButtonStyle(prominent: false))
      .accessibilityHint(speaker.isSpeaking ? "" : "Reads the briefing aloud")

      Button {
        speaker.stop()
        onAcknowledge()
      } label: {
        Text(remaining > 0 ? "Check off \(remaining) \(remaining == 1 ? "item" : "items") to continue" : primaryTitle)
      }
      .buttonStyle(InkButtonStyle())
      .disabled(remaining > 0)

      Button("Skip") { speaker.stop(); onSkip() }
        .font(.footnote).foregroundStyle(Theme.ink3)
        .frame(minHeight: 44)
    }
    .padding(.horizontal, 16)
    .padding(.top, 10)
    .padding(.bottom, 8)
    .background(Theme.page)
    .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
  }

  // MARK: - Pieces

  @ViewBuilder
  private func whoWhen(_ item: BriefingItem) -> some View {
    let parts = [item.who, item.when.map { $0.formatted(date: .omitted, time: .shortened) }].compactMap { $0 }
    if !parts.isEmpty {
      Text(parts.joined(separator: " · ")).font(Theme.mono(monoSize)).foregroundStyle(Theme.ink3)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  @ViewBuilder
  private func placeAndWho(_ item: BriefingItem) -> some View {
    if let place = item.place { StatusPill(text: place, tone: .neutral, systemImage: "mappin") }
    whoWhen(item)
  }

  private func severityWord(_ s: BriefingItem.Severity) -> String {
    switch s {
    case .critical: "Critical"
    case .warning: "Warning"
    case .info: "Info"
    }
  }

  private func acknowledgedCount(_ items: [BriefingItem]) -> Int {
    items.filter { acknowledged.contains($0.id) }.count
  }

  private func color(_ s: BriefingItem.Severity) -> Color {
    switch s {
    case .critical: Theme.critical
    case .warning: Theme.warning
    case .info: Theme.accent
    }
  }
}
