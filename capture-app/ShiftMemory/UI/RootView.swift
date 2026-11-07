// Placeholder for the scaffold build; replaced by the full UI.
import SwiftUI

struct RootView: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    VStack(spacing: 12) {
      Text("Shift Memory").font(.title2.weight(.semibold)).foregroundStyle(Theme.ink)
      StatusPill(text: "scaffold", tone: .pending, systemImage: "hammer")
      Text(model.config.deviceId).font(Theme.mono(12)).foregroundStyle(Theme.ink3)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.page)
  }
}
