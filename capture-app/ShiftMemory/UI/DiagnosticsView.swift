//
// DiagnosticsView.swift
// Shift Memory
//
// The numbers MEASUREMENTS.md asks for, read off the phone: capture→bytes medians per
// resolution/quality, startup failure rates, how many shutter photos arrived while backgrounded,
// battery drain per hour, and the raw rows. Export is a CSV via the share sheet.
//

import SwiftUI

struct DiagnosticsView: View {
  @Environment(AppModel.self) private var model
  @State private var exportURL: URL?
  @State private var exportError: String?
  @State private var confirmReset = false

  var body: some View {
    let d = model.diagnostics
    let s = d.summary
    List {
      Section("Summary") {
        LabeledContent("Captures", value: "\(s.captureCount)")
        ForEach(s.bySource.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
          LabeledContent("  \(CaptureSource(rawValue: k)?.label ?? k)", value: "\(v)")
        }
        ForEach(s.byFormat.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
          LabeledContent("  \(k.uppercased()) arrivals", value: "\(v)")
        }
      }

      Section {
        if s.captureToBytesBySetting.isEmpty {
          Text("No app-requested captures yet.").foregroundStyle(Theme.ink3)
        }
        ForEach(s.captureToBytesBySetting.sorted(by: { $0.key < $1.key }), id: \.key) { k, v in
          LabeledContent(k) {
            Text("p50 \(v.medianMs) ms · p90 \(v.p90Ms) ms · n=\(v.count)").font(Theme.mono(12))
          }
        }
        if let ms = s.uploadToAcceptedMedianMs { LabeledContent("Upload → accepted (p50)", value: "\(ms) ms") }
        if let ms = s.bytesToInGraphMedianMs { LabeledContent("Bytes → in graph (p50)", value: "\(ms) ms") }
      } header: {
        Text("Capture → bytes by resolution · quality")
      }

      Section("Reliability") {
        LabeledContent("Session start failures", value: rate(s.sessionStartFailureRate, d.session.sessionStartAttempts))
        LabeledContent("Camera start failures", value: rate(s.photoStartFailureRate, d.session.photoStartAttempts))
        if let ms = d.session.lastSessionStartMs { LabeledContent("Last session start", value: "\(ms) ms") }
        if let e = d.session.lastSessionError { Text(e).font(.footnote).foregroundStyle(Theme.criticalInk) }
      }

      Section {
        LabeledContent("Arrived while backgrounded", value: "\(s.shutterBackgrounded)")
        LabeledContent("Arrived in foreground", value: "\(s.shutterForeground)")
      } header: {
        Text("Shutter-button photos")
      } footer: {
        Text("Decides whether camera-roll import (#2) is needed. Take photos with the app backgrounded and watch this count.")
      }

      Section("Battery") {
        LabeledContent("Glasses drain / hour", value: s.glassesDrainPerHour.map { String(format: "%.1f %%", $0) } ?? "need 10+ min of samples")
        LabeledContent("Samples", value: "\(d.battery.count)")
      }

      Section("Rows (\(d.captures.count))") {
        if d.captures.isEmpty { Text("Nothing recorded yet.").foregroundStyle(Theme.ink3) }
        ForEach(d.captures.prefix(100)) { m in
          VStack(alignment: .leading, spacing: 3) {
            HStack {
              Image(systemName: m.source?.systemImage ?? "questionmark").font(.caption).foregroundStyle(Theme.ink3)
              Text(m.id).font(Theme.mono(11)).foregroundStyle(Theme.ink2).lineLimit(1).truncationMode(.middle)
              Spacer()
              if let ms = m.captureToBytesMs { Text("\(ms) ms").font(Theme.mono(11)).foregroundStyle(Theme.ink2) }
            }
            Text(detail(m)).font(.caption).foregroundStyle(m.error == nil ? Theme.ink3 : Theme.criticalInk).lineLimit(2)
          }
        }
      }

      Section {
        Button("Export CSV") {
          do { exportURL = try d.exportCSV(); exportError = nil } catch { exportError = error.localizedDescription }
        }
        if let exportURL { ShareLink(item: exportURL) { Label("Share \(exportURL.lastPathComponent)", systemImage: "square.and.arrow.up") } }
        if let exportError { Text(exportError).font(.footnote).foregroundStyle(Theme.criticalInk) }
        if let e = d.lastSaveError { Text("Save failed: \(e)").font(.footnote).foregroundStyle(Theme.criticalInk) }
        Button("Reset diagnostics", role: .destructive) { confirmReset = true }
      }
    }
    .scrollContentBackground(.hidden)
    .background(Theme.page)
    .navigationTitle("Diagnostics")
    .navigationBarTitleDisplayMode(.inline)
    .confirmationDialog("Delete all diagnostics rows?", isPresented: $confirmReset, titleVisibility: .visible) {
      Button("Reset", role: .destructive) { d.reset(); exportURL = nil }
    }
  }

  private func rate(_ r: Double?, _ n: Int) -> String {
    guard let r else { return "no attempts" }
    return String(format: "%.0f%% of %d", r * 100, n)
  }

  private func detail(_ m: CaptureMetrics) -> String {
    var parts: [String] = []
    if let r = m.requestedResolution, let q = m.requestedQuality { parts.append("\(r)/\(q)") }
    if let f = m.format { parts.append(f.rawValue) }
    if let b = m.bytes { parts.append("\(b / 1024) KB") }
    if let p = m.originalPixels { parts.append(p) }
    if let a = m.appStateAtArrival { parts.append(a) }
    if let g = m.glassesBattery { parts.append("glasses \(g)%") }
    if let e = m.error { parts.append(e) }
    return parts.isEmpty ? "—" : parts.joined(separator: " · ")
  }
}
