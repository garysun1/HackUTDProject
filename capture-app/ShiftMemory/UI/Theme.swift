//
// Theme.swift
// Shift Memory
//
// Design tokens mirrored from web/src/styles.css so the phone and the console read as one
// product: warm white page, white surfaces, hairlines, near-black ink, one accent, status as
// tinted pills with ink text, monospace only for times, IDs and readings. Dark values are the
// console's dark tokens and follow the system appearance.
//

import SwiftUI
import UIKit

enum Theme {
  // Surfaces
  static let page = Color(light: 0xF7F7F5, dark: 0x191919)
  static let ground = Color(light: 0xFFFFFF, dark: 0x1F1F1F)
  static let panel = Color(light: 0xF4F4F1, dark: 0x262626)
  static let hover = Color(light: 0xF0F0EC, dark: 0x2B2B2B)

  // Hairlines
  static let line = Color(light: 0xE5E5E1, dark: 0x333333)
  static let lineSoft = Color(light: 0xEDEDEA, dark: 0x2A2A2A)
  static let lineStrong = Color(light: 0xD4D4CF, dark: 0x444444)

  // Ink
  static let ink = Color(light: 0x1F1F1D, dark: 0xECECEA)
  static let ink2 = Color(light: 0x4F4E4A, dark: 0xBDBCB7)
  static let ink3 = Color(light: 0x6B6A66, dark: 0x9A9994)
  static let ink4 = Color(light: 0x8A8982, dark: 0x7D7C77)

  // Accent (links, focus, the one blue)
  static let accent = Color(light: 0x2563EB, dark: 0x5B8DEF)

  // Status: fill, text on tint, tint
  static let critical = Color(light: 0xD03B3B, dark: 0xE66767)
  static let criticalInk = Color(light: 0xA32626, dark: 0xFF8A8A)
  static let criticalBg = Color(light: 0xFDEAEA, dark: 0x3A1F1F)
  static let warning = Color(light: 0xFAB219, dark: 0xFAB219)
  static let warningInk = Color(light: 0x7A5300, dark: 0xFFD37A)
  static let warningBg = Color(light: 0xFFF4D6, dark: 0x3A2F14)
  static let good = Color(light: 0x0CA30C, dark: 0x0CA30C)
  static let goodInk = Color(light: 0x0B7A0B, dark: 0x4FD34F)
  static let goodBg = Color(light: 0xE8F7E8, dark: 0x1C3A1C)

  // Places and entities (same hues the floor schematic uses)
  static let place = Color(light: 0x0F8A5F, dark: 0x2BB383)
  static let entity = Color(light: 0x5B4BD0, dark: 0xA197F0)

  // Shape: the console uses 6px radii and 1px hairlines; cards on a phone get a touch more.
  static let radiusSmall: CGFloat = 6
  static let radius: CGFloat = 10
  @MainActor static var hairline: CGFloat { 1 / UIScreen.main.scale }

  // Type: SF for UI, SF Mono only for times, IDs and readings (the console's Inter / JetBrains Mono).
  static func mono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
    .system(size: size, weight: weight, design: .monospaced)
  }
}

extension Color {
  /// A dynamic color from two sRGB hex values, light then dark.
  init(light: UInt32, dark: UInt32) {
    self.init(uiColor: UIColor { traits in
      let hex = traits.userInterfaceStyle == .dark ? dark : light
      return UIColor(
        red: CGFloat((hex >> 16) & 0xFF) / 255,
        green: CGFloat((hex >> 8) & 0xFF) / 255,
        blue: CGFloat(hex & 0xFF) / 255,
        alpha: 1
      )
    })
  }
}

// MARK: - Shared chrome

/// A white surface with a hairline border, the console's panel.
struct Surface<Content: View>: View {
  var padding: CGFloat = 14
  @ViewBuilder var content: Content
  var body: some View {
    content
      .padding(padding)
      .background(Theme.ground, in: RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: Theme.radius, style: .continuous)
          .strokeBorder(Theme.line, lineWidth: 1)
      )
  }
}

/// Panel heading: 14px semibold in full ink, like `.colhead h2` on the console.
struct PanelHead: View {
  let title: String
  var trailing: String? = nil
  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
      Spacer()
      if let trailing {
        Text(trailing).font(.footnote).foregroundStyle(Theme.ink3).monospacedDigit()
      }
    }
  }
}

/// Status always ships with a word. Tinted pill, ink text, the console's `.st` chip.
struct StatusPill: View {
  enum Tone { case neutral, pending, good, critical, accent }
  let text: String
  var tone: Tone = .neutral
  var systemImage: String? = nil

  var body: some View {
    HStack(spacing: 4) {
      if let systemImage { Image(systemName: systemImage).font(.system(size: 10, weight: .semibold)) }
      Text(text)
    }
    .font(.system(size: 11, weight: .medium))
    .padding(.horizontal, 7)
    .padding(.vertical, 2)
    .foregroundStyle(fg)
    .background(bg, in: Capsule())
    .accessibilityLabel(text)
  }
  private var fg: Color {
    switch tone {
    case .neutral: Theme.ink2
    case .pending: Theme.warningInk
    case .good: Theme.goodInk
    case .critical: Theme.criticalInk
    case .accent: Theme.accent
    }
  }
  private var bg: Color {
    switch tone {
    case .neutral: Theme.panel
    case .pending: Theme.warningBg
    case .good: Theme.goodBg
    case .critical: Theme.criticalBg
    case .accent: Theme.accent.opacity(0.12)
    }
  }
}

/// The console's ink-filled primary button and outlined secondary button.
struct InkButtonStyle: ButtonStyle {
  var prominent = true
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.subheadline.weight(.semibold))
      .padding(.horizontal, 14)
      .frame(minHeight: 44)
      .frame(maxWidth: .infinity)
      .foregroundStyle(prominent ? Theme.ground : Theme.ink)
      .background(
        RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous)
          .fill(prominent ? Theme.ink : Theme.ground)
      )
      .overlay(
        RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous)
          .strokeBorder(prominent ? Color.clear : Theme.lineStrong, lineWidth: 1)
      )
      .opacity(configuration.isPressed ? 0.85 : 1)
      .scaleEffect(configuration.isPressed ? 0.995 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
