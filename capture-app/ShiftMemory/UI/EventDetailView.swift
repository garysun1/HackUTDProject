//
// EventDetailView.swift
// Shift Memory
//
// One event: the uploaded (face-blurred) photo, what the module said about it, the fields that
// went in the envelope, and a place to add a note or label after the fact (set_note / set_label).
//

import SwiftUI

struct EventDetailView: View {
  @Environment(AppModel.self) private var model
  let eventId: String
  @State private var note = ""
  @State private var label = ""
  @State private var saving = false
  @State private var saveError: String?

  private var event: CaptureEvent? { model.store.event(id: eventId) }

  var body: some View {
    ScrollView {
      if let event {
        VStack(alignment: .leading, spacing: 12) {
          photo(event)
          Surface {
            VStack(alignment: .leading, spacing: 8) {
              HStack {
                StagePill(stage: event.stage)
                Spacer()
                Text(event.clientT, format: .dateTime.month(.abbreviated).day().hour().minute().second())
                  .font(Theme.mono(12)).foregroundStyle(Theme.ink3)
              }
              Text(summary(event)).font(.body).foregroundStyle(event.stage == .failed ? Theme.criticalInk : Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          Surface {
            VStack(alignment: .leading, spacing: 10) {
              PanelHead(title: "Annotate")
              TextField("Label, e.g. rack-07", text: $label).textInputAutocapitalization(.never).autocorrectionDisabled()
              Divider()
              TextField("Note", text: $note, axis: .vertical).lineLimit(1...4)
              if let saveError { Text(saveError).font(.footnote).foregroundStyle(Theme.criticalInk) }
              Button(saving ? "Saving…" : "Save to the graph") { Task { await save(event) } }
                .buttonStyle(InkButtonStyle(prominent: false))
                .disabled(saving || !event.stage.isTerminal && event.stage != .accepted)
            }
            .font(.subheadline)
          }
          Surface {
            VStack(alignment: .leading, spacing: 6) {
              PanelHead(title: "Provenance")
              row("event_id", event.id)
              row("device_id", event.deviceId)
              row("source", event.source.rawValue)
              row("client_t", EventEnvelope.iso8601(event.clientT, offsetSeconds: event.clientTZOffsetSeconds))
              if let s = event.serverT { row("server_t", s.formatted(.iso8601)) }
              if let o = event.clockOffsetMs { row("clock_offset_ms", "\(o)") }
              if let w = event.wearer { row("wearer", w) }
              row("photo", "\(event.width)×\(event.height) · \(event.jpegBytes / 1024) KB · \(event.facesBlurred) face\(event.facesBlurred == 1 ? "" : "s") blurred")
              if let fix = event.location {
                row("location", String(format: "%.6f, %.6f ±%.0f m", fix.lat, fix.lon, fix.accuracyM) + (fix.floor.map { " · floor \($0)" } ?? ""))
              }
              if let shiftId = event.shiftId { row("shift_id", shiftId) }
              row("attempts", "\(event.attempts)")
              if let e = event.lastError { row("error", e) }
            }
          }
        }
        .padding(16)
      } else {
        ContentUnavailableView("Event removed", systemImage: "photo.badge.exclamationmark")
      }
    }
    .background(Theme.page)
    .navigationTitle(event?.label ?? "Event")
    .navigationBarTitleDisplayMode(.inline)
    .onAppear {
      note = event?.note ?? ""
      label = event?.label ?? ""
    }
  }

  @ViewBuilder
  private func photo(_ event: CaptureEvent) -> some View {
    if let image = model.store.photo(for: event.id) {
      Image(uiImage: image).resizable().scaledToFit()
        .clipShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).strokeBorder(Theme.line))
        .accessibilityLabel("Uploaded photo, faces blurred")
    } else {
      RoundedRectangle(cornerRadius: Theme.radius, style: .continuous).fill(Theme.panel)
        .frame(height: 220)
        .overlay(Text("Photo no longer on this phone").font(.footnote).foregroundStyle(Theme.ink3))
    }
  }

  private func row(_ key: String, _ value: String) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 10) {
      Text(key).font(Theme.mono(11)).foregroundStyle(Theme.ink4).frame(width: 110, alignment: .leading)
      Text(value).font(Theme.mono(12)).foregroundStyle(Theme.ink2).textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
      Spacer(minLength: 0)
    }
  }

  private func summary(_ event: CaptureEvent) -> String {
    if let s = event.summary, !s.isEmpty { return s }
    switch event.stage {
    case .accepted: return "The module stored the photo and is reading it…"
    case .inGraph: return "In the graph."
    case .duplicate: return "The module already had this event."
    case .failed: return event.lastError ?? "Failed."
    default: return event.lastError ?? "Waiting to upload."
    }
  }

  private func save(_ event: CaptureEvent) async {
    saving = true; defer { saving = false }
    saveError = nil
    do {
      let trimmedNote = note.trimmingCharacters(in: .whitespacesAndNewlines)
      let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
      if trimmedNote != (event.note ?? "") { try await model.setNote(eventId: event.id, note: trimmedNote) }
      if trimmedLabel != (event.label ?? "") { try await model.setLabel(eventId: event.id, label: trimmedLabel) }
      model.store.update(id: event.id) { e in
        e.note = trimmedNote.isEmpty ? nil : trimmedNote
        e.label = trimmedLabel.isEmpty ? nil : trimmedLabel
      }
    } catch {
      saveError = error.userMessage
    }
  }
}
