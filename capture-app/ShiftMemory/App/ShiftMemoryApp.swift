//
// ShiftMemoryApp.swift
// Shift Memory
//
// Capture side of Working Memory for the Physical World (HackUTD 2026). Operators photograph
// discrete moments with Meta glasses; this app receives the photos, blurs faces, resizes, and
// uploads each one as an event to the SpacetimeDB module. See capture-app/README.md.
//

import MWDATCore
import SwiftUI

@main
struct ShiftMemoryApp: App {
  @State private var model: AppModel

  init() {
    #if DEBUG
    DebugMock.enableIfRequested()
    #endif
    do {
      try Wearables.configure()
    } catch {
      // Without the toolkit the app still runs (settings, camera-roll import, diagnostics).
      NSLog("[ShiftMemory] Wearables.configure failed: \(error)")
    }
    _model = State(wrappedValue: AppModel())
  }

  var body: some Scene {
    WindowGroup {
      RootView()
        .environment(model)
        .onOpenURL { url in
          // Meta AI calls back after registration and permission prompts.
          guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
                components.queryItems?.contains(where: { $0.name == "metaWearablesAction" }) == true
          else { return }
          Task { await model.glasses.handle(callbackURL: url) }
        }
    }
  }
}
