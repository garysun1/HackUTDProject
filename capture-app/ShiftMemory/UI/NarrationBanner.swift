//
// NarrationBanner.swift
// Shift Memory
//
// The Capture card's view of a voice narration: while listening, a pulsing mic, a small level
// meter, the newest words of the live transcript and a Done button; while the recognizer settles,
// "Adding your note…"; when narration cannot run, why. When idle it stays out of the way except for
// 20 s after a note was produced, when it echoes "Note: …" so the wearer sees what was kept.
//

import SwiftUI

struct NarrationBanner: View {
  let narrator: VoiceNarrator
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  /// How long a finished note stays echoed under the Capture button.
  static let recentWindow: TimeInterval = 20

  var body: some View {
    switch narrator.state {
    case .listening:
      listening
    case .finishing:
      HStack(spacing: 8) {
        ProgressView().controlSize(.small)
        Text("Adding your note…").font(.footnote).foregroundStyle(Theme.ink2)
        Spacer(minLength: 0)
      }
      .frame(minHeight: 44)
      .accessibilityElement(children: .combine)
    case .unavailable(let reason):
      Label(reason, systemImage: "mic.slash")
        .accessibilityLabel("Spoken notes unavailable: \(reason)")
        .font(.footnote).foregroundStyle(Theme.ink3)
        .fixedSize(horizontal: false, vertical: true)
    case .idle:
      recentNote
    }
  }

  private var listening: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 10) {
        Image(systemName: "mic.fill")
          .font(.subheadline.weight(.semibold))
          .foregroundStyle(Theme.critical)
          .symbolEffect(.pulse, options: .repeating, isActive: !reduceMotion)
          .accessibilityHidden(true)
        Text("Listening").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
          .lineLimit(1)
        LevelMeter(level: narrator.level)
        Spacer(minLength: 0)
        Button { narrator.stop() } label: {
          // Frame and shape inside the label so the whole 44 pt box is tappable, not just the word.
          Text("Done")
            .font(.subheadline.weight(.semibold))
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
        }
        .accessibilityHint("Stops listening and keeps what you said as the photo's note")
      }
      Text(narrator.liveTranscript.isEmpty ? "Say what you see or did…" : narrator.liveTranscript)
        .font(.subheadline)
        .foregroundStyle(narrator.liveTranscript.isEmpty ? Theme.ink4 : Theme.ink)
        .lineLimit(3)
        .truncationMode(.head)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(narrator.liveTranscript.isEmpty ? "Listening for your note" : "Heard: \(narrator.liveTranscript)")
    }
    .padding(10)
    .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
  }

  @ViewBuilder
  private var recentNote: some View {
    if let text = narrator.lastTranscript, let at = narrator.lastTranscriptAt,
       Date().timeIntervalSince(at) < Self.recentWindow {
      // Re-evaluated each second so the echo disappears on its own after the window.
      TimelineView(.periodic(from: at, by: 1)) { context in
        if context.date.timeIntervalSince(at) < Self.recentWindow {
          Label {
            Text("Note: \(text)").lineLimit(3)
          } icon: {
            Image(systemName: "text.bubble")
          }
          .font(.footnote).foregroundStyle(Theme.ink2)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
      }
    }
  }
}

/// Five bars lit by input level; Theme ink with a hairline track.
private struct LevelMeter: View {
  let level: Float
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private let bars = 5

  var body: some View {
    HStack(alignment: .bottom, spacing: 2) {
      ForEach(0..<bars, id: \.self) { i in
        let threshold = Float(i + 1) / Float(bars + 1)
        RoundedRectangle(cornerRadius: 1, style: .continuous)
          .fill(level >= threshold ? Theme.ink2 : Theme.lineStrong)
          .frame(width: 3, height: 5 + CGFloat(i) * 2.5)
      }
    }
    .frame(height: 16, alignment: .bottom)
    .animation(reduceMotion ? nil : .easeOut(duration: 0.08), value: level)
    .accessibilityHidden(true)
  }
}
