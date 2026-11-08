//
// FloorView.swift
// Shift Memory
//
// The floor as a place: rows of racks drawn left to right from the registry's `location` text, row-end
// units at the aisle end, rooms without a row as side panels. Every open alert burns on the tile of
// the asset it is about; when a wearer photographs the fix and the alert is resolved, the tile goes
// out (glow shrinks, red → green check with a ring burst, then back to neutral after ~20 s). That
// transition is the visible form of the shared memory being updated. Below the map, the same issues
// as a plain list for VoiceOver and for skimming. Tapping a tile opens AssetSheet.
//

import SwiftUI

// MARK: - Map model

/// The drawable floor: rows with rack slots and row-end units, then side zones. Pure, so tests can pin it.
struct FloorMap: Equatable {
  struct Slot: Identifiable, Equatable {
    let id: String          // stable key: "Row 1/R12", "end:CRAC-2", "zone:UPS-1"
    let title: String       // rack id or asset id, drawn large
    let assets: [FloorAsset]
  }
  struct Row: Identifiable, Equatable {
    var id: String { name }
    let name: String
    let racks: [Slot]
    let ends: [Slot]        // row-end units and row-level assets that are not racks
  }
  struct Zone: Identifiable, Equatable {
    var id: String { name }
    let name: String
    let slots: [Slot]
  }

  let rows: [Row]
  let zones: [Zone]
  var isEmpty: Bool { rows.isEmpty && zones.isEmpty }

  /// Racks come from "Rack Rxx" in a location, or from a `rack`-type asset whose id names its rack
  /// ("R12", location "Row 1"), so PDUs in R12 and the R12 rack itself share one tile.
  static func build(_ assets: [FloorAsset]) -> FloorMap {
    let layout = FloorGeometry.layout(assets)
    func rackKey(_ a: FloorAsset) -> String? {
      if let rack = a.place.rack { return rack }
      if a.place.row != nil, !a.place.isRowEnd, a.type.lowercased() == "rack" { return a.id }
      return nil
    }
    var rows: [Row] = []
    for (rowName, layoutRacks) in layout.rows {
      let inRow = assets.filter { $0.place.row == rowName }
      var rackIds = layoutRacks
      for a in inRow { if let k = rackKey(a), !rackIds.contains(k) { rackIds.append(k) } }
      rackIds.sort { $0.localizedStandardCompare($1) == .orderedAscending }
      let racks = rackIds.map { rack in
        Slot(id: "\(rowName)/\(rack)", title: rack,
             assets: inRow.filter { rackKey($0) == rack }.sorted(by: rackOrder))
      }
      let ends = inRow.filter { rackKey($0) == nil }
        .sorted { $0.id.localizedStandardCompare($1.id) == .orderedAscending }
        .map { Slot(id: "end:\($0.id)", title: $0.id, assets: [$0]) }
      rows.append(Row(name: rowName, racks: racks, ends: ends))
    }
    // Everything without a row is a side zone. FloorGeometry leaves `zone` nil for a rack with no
    // row ("Rack R40"), so name the zone after the location rather than dropping the asset.
    func zoneKey(_ a: FloorAsset) -> String {
      a.place.zone ?? a.location.trimmingCharacters(in: .whitespaces).nilIfEmpty ?? "Unplaced"
    }
    let rowless = assets.filter { $0.place.row == nil }
    let zoneNames = Set(rowless.map(zoneKey)).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
    let zones = zoneNames.map { zone in
      Zone(name: zone, slots: rowless.filter { zoneKey($0) == zone }
        .sorted { $0.id.localizedStandardCompare($1.id) == .orderedAscending }
        .map { Slot(id: "zone:\($0.id)", title: $0.id, assets: [$0]) })
    }
    return FloorMap(rows: rows, zones: zones)
  }

  /// The rack itself first, then what is mounted in it by id.
  private static func rackOrder(_ a: FloorAsset, _ b: FloorAsset) -> Bool {
    let ar = a.type.lowercased() == "rack", br = b.type.lowercased() == "rack"
    if ar != br { return ar }
    return a.id.localizedStandardCompare(b.id) == .orderedAscending
  }
}

/// SF Symbol for an asset_type.
func floorSymbol(forType type: String) -> String {
  let t = type.lowercased()
  if t.contains("pdu") || t.contains("power") { return "bolt" }
  if t.contains("switch") || t.contains("router") || t.contains("network") { return "network" }
  if t.contains("crac") || t.contains("chiller") { return "snowflake" }
  if t.contains("cool") || t.contains("fan") || t.contains("ahu") { return "fan" }
  if t.contains("ups") || t.contains("battery") { return "battery.100percent" }
  if t.contains("rack") || t.contains("server") { return "server.rack" }
  return "cube"
}

// MARK: - Floor view

struct FloorView: View {
  let store: FloorStore
  let onFixWithPhoto: (FloorAsset, FloorIssue?) -> Void
  let onOpenEvent: (String) -> Void

  @State private var sheet: SheetTarget?
  @State private var confirming: FloorIssue?
  /// A navigation callback chosen in the sheet, run once the sheet has finished dismissing.
  @State private var afterSheet: (() -> Void)?

  init(store: FloorStore, onFixWithPhoto: @escaping (FloorAsset, FloorIssue?) -> Void,
       onOpenEvent: @escaping (String) -> Void) {
    self.store = store
    self.onFixWithPhoto = onFixWithPhoto
    self.onOpenEvent = onOpenEvent
  }

  var body: some View {
    let map = FloorMap.build(store.snapshot.assets)
    ScrollView {
      VStack(spacing: 12) {
        FloorHeader(store: store)
        if map.isEmpty {
          emptyState
        } else {
          ForEach(map.rows) { row in
            RowPanel(row: row, store: store, open: open)
          }
          if !map.zones.isEmpty {
            ForEach(map.zones) { zone in
              ZonePanel(zone: zone, store: store, open: open)
            }
          }
          FloorLegend()
        }
        IssueList(store: store, map: map, open: open, confirm: { confirming = $0 })
      }
      .padding(.horizontal, 16)
      .padding(.vertical, 8)
    }
    .background(Theme.page)
    .navigationTitle("Floor")
    .navigationBarTitleDisplayMode(.inline)
    .toolbar {
      ToolbarItem(placement: .topBarTrailing) {
        Button { Task { await store.refresh() } } label: {
          Image(systemName: "arrow.clockwise").accessibilityLabel("Refresh floor")
        }
        .disabled(store.isLoading)
      }
    }
    .refreshable { await store.refresh() }
    .onAppear { store.startPolling() }
    .onDisappear { store.stopPolling() }
    .sheet(item: $sheet, onDismiss: {
      let action = afterSheet
      afterSheet = nil
      action?()
    }) { target in
      AssetSheet(
        store: store, assets: target.assets, initialAssetId: target.initialAssetId,
        onFixWithPhoto: { asset, issue in
          afterSheet = { onFixWithPhoto(asset, issue) }
          sheet = nil
        },
        onOpenEvent: { id in
          afterSheet = { onOpenEvent(id) }
          sheet = nil
        })
    }
    .resolveConfirmation(store: store, issue: $confirming)
  }

  private func open(_ slot: FloorMap.Slot, focus: FloorAsset? = nil) {
    let initial = focus?.id
      ?? slot.assets.first { if case .burning = store.state(for: $0) { true } else { false } }?.id
      ?? slot.assets.first?.id ?? ""
    sheet = SheetTarget(id: slot.id, assets: slot.assets, initialAssetId: initial)
  }

  @ViewBuilder private var emptyState: some View {
    Surface {
      VStack(spacing: 8) {
        Image(systemName: "square.grid.3x3.square").font(.title2).foregroundStyle(Theme.ink4)
        Text(store.isLoading ? "Reading the floor…" : "No floor registry yet")
          .font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink2)
        Text("The map draws the backend's asset table (rows, racks, rooms). Load the registry on the backend, or check Settings if the backend is not reachable.")
          .font(.footnote).foregroundStyle(Theme.ink3).multilineTextAlignment(.center)
          .fixedSize(horizontal: false, vertical: true)
        Button("Try again") { Task { await store.refresh() } }
          .buttonStyle(InkButtonStyle(prominent: false))
          .disabled(store.isLoading)
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, 12)
    }
  }
}

private struct SheetTarget: Identifiable {
  let id: String
  let assets: [FloorAsset]
  let initialAssetId: String
}

// MARK: - Header

private struct FloorHeader: View {
  let store: FloorStore
  var body: some View {
    let open = store.openCount
    let resolved = store.resolvedThisShiftCount()
    Surface {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Image(systemName: open > 0 ? "flame.fill" : "checkmark.seal.fill")
            .foregroundStyle(open > 0 ? Theme.critical : Theme.good)
            .contentTransition(.symbolEffect(.replace))
          Text("\(open) open · \(resolved) resolved this shift")
            .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
            .monospacedDigit()
            .contentTransition(.numericText())
          Spacer(minLength: 0)
          if store.isLoading { ProgressView().controlSize(.small) }
        }
        .animation(.snappy, value: open)
        if let error = store.lastError {
          Text(error).font(.footnote).foregroundStyle(Theme.criticalInk)
            .fixedSize(horizontal: false, vertical: true)
        } else if store.snapshot.fetchedAt != .distantPast {
          HStack(spacing: 4) {
            Text("Live from shared memory · updated")
            Text(store.snapshot.fetchedAt, format: .dateTime.hour().minute().second()).font(Theme.mono(12))
          }
          .font(.footnote).foregroundStyle(Theme.ink3)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .accessibilityElement(children: .combine)
  }
}

// MARK: - Rows and zones

private struct RowPanel: View {
  let row: FloorMap.Row
  let store: FloorStore
  let open: (FloorMap.Slot, FloorAsset?) -> Void

  var body: some View {
    let burning = (row.racks + row.ends).flatMap(\.assets).reduce(0) { $0 + store.issues(for: $1).filter { !$0.isResolved }.count }
    Surface(padding: 12) {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline) {
          Label(row.name, systemImage: "square.split.bottomrightquarter")
            .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
          Spacer()
          if burning > 0 { StatusPill(text: "\(burning) open", tone: .critical, systemImage: "flame.fill") }
          else { StatusPill(text: "clear", tone: .neutral) }
        }
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(alignment: .top, spacing: 8) {
            ForEach(row.racks) { slot in
              MapTile(slot: slot, store: store) { open(slot, nil) }
            }
            if !row.ends.isEmpty {
              AisleEndMarker()
              ForEach(row.ends) { slot in
                MapTile(slot: slot, store: store) { open(slot, nil) }
              }
            }
          }
          .padding(14)   // room for the burning glow and the extinguish burst; the scroll view clips
        }
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
        // The aisle: a dashed walkway along the front of the racks.
        HStack(spacing: 6) {
          Image(systemName: "figure.walk").font(.caption2)
          Text("aisle").font(Theme.mono(11))
          DashedLine().stroke(Theme.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 4])).frame(height: 1)
        }
        .foregroundStyle(Theme.ink4)
        .accessibilityHidden(true)
      }
    }
  }
}

private struct AisleEndMarker: View {
  var body: some View {
    VStack(spacing: 4) {
      DashedLine(vertical: true).stroke(Theme.lineStrong, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
        .frame(width: 1)
      Text("end").font(Theme.mono(10)).foregroundStyle(Theme.ink4)
    }
    .frame(minHeight: 80)
    .padding(.horizontal, 2)
    .accessibilityHidden(true)
  }
}

private struct DashedLine: Shape {
  var vertical = false
  func path(in rect: CGRect) -> Path {
    var p = Path()
    if vertical { p.move(to: CGPoint(x: rect.midX, y: rect.minY)); p.addLine(to: CGPoint(x: rect.midX, y: rect.maxY)) }
    else { p.move(to: CGPoint(x: rect.minX, y: rect.midY)); p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY)) }
    return p
  }
}

private struct ZonePanel: View {
  let zone: FloorMap.Zone
  let store: FloorStore
  let open: (FloorMap.Slot, FloorAsset?) -> Void

  var body: some View {
    Surface(padding: 12) {
      VStack(alignment: .leading, spacing: 10) {
        Label(zone.name, systemImage: "door.left.hand.closed")
          .font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(alignment: .top, spacing: 8) {
            ForEach(zone.slots) { slot in
              MapTile(slot: slot, store: store) { open(slot, nil) }
            }
          }
          .padding(14)   // room for the burning glow and the extinguish burst; the scroll view clips
        }
        .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
      }
    }
  }
}

private struct FloorLegend: View {
  var body: some View {
    HStack(spacing: 8) {
      StatusPill(text: "open issue", tone: .critical, systemImage: "flame.fill")
      StatusPill(text: "just resolved", tone: .good, systemImage: "checkmark.circle.fill")
      StatusPill(text: "new photo", tone: .accent, systemImage: "camera.fill")
      Spacer(minLength: 0)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Legend: red flame is an open issue, green check is just resolved, blue is a new photo")
  }
}

// MARK: - Tile

/// What one tile shows: the hottest state among the assets on it.
enum TileLook: Equatable {
  case burning(count: Int)
  case extinguished(at: Date)
  case touched(at: Date)
  case idle

  @MainActor static func of(_ assets: [FloorAsset], store: FloorStore, now: Date = Date()) -> TileLook {
    var open = 0
    var outAt: Date?
    var touchedAt: Date?
    for a in assets {
      switch store.state(for: a, now: now) {
      case .burning(let issues): open += issues.count
      case .extinguished(let at): outAt = max(outAt ?? at, at)
      case .touched: if let t = store.recentlyTouched[a.id] { touchedAt = max(touchedAt ?? t, t) }
      case .idle: break
      }
    }
    if open > 0 { return .burning(count: open) }
    if let outAt { return .extinguished(at: outAt) }
    if let touchedAt { return .touched(at: touchedAt) }
    return .idle
  }
}

private struct MapTile: View {
  let slot: FloorMap.Slot
  let store: FloorStore
  let action: () -> Void
  @ScaledMetric(relativeTo: .body) private var width: CGFloat = 128
  @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = 112

  var body: some View {
    let look = TileLook.of(slot.assets, store: store)
    Button(action: action) {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .top, spacing: 4) {
          Image(systemName: floorSymbol(forType: primaryType)).font(.footnote.weight(.semibold))
            .foregroundStyle(iconColor(look))
          Spacer(minLength: 0)
          TileBadge(look: look)
        }
        Text(slot.title).font(Theme.mono(20, weight: .semibold)).foregroundStyle(Theme.ink)
          .lineLimit(1).minimumScaleFactor(0.6)
        VStack(alignment: .leading, spacing: 2) {
          ForEach(slot.assets) { a in
            Label(a.name, systemImage: floorSymbol(forType: a.type))
              .labelStyle(TightLabel())
              .font(.caption2).foregroundStyle(Theme.ink3).lineLimit(1)
          }
        }
        Spacer(minLength: 0)
      }
      .padding(10)
      .frame(width: width, alignment: .leading)
      .frame(minHeight: minHeight, alignment: .topLeading)
      .background { TileBackground(look: look) }
      .contentShape(RoundedRectangle(cornerRadius: Theme.radius, style: .continuous))
    }
    .buttonStyle(TilePressStyle())
    .animation(.easeInOut(duration: 0.6), value: look)
    .accessibilityLabel(accessibilityText(look))
    .accessibilityHint("Opens the asset, its issues and recent photos")
  }

  private var primaryType: String {
    slot.assets.first { $0.type.lowercased() == "rack" }?.type ?? slot.assets.first?.type ?? ""
  }

  private func iconColor(_ look: TileLook) -> Color {
    switch look {
    case .burning: Theme.critical
    case .extinguished: Theme.good
    case .touched: Theme.accent
    case .idle: Theme.ink3
    }
  }

  private func accessibilityText(_ look: TileLook) -> String {
    let names = slot.assets.map(\.name).joined(separator: ", ")
    let state: String = switch look {
    case .burning(let n): "\(n) open issue\(n == 1 ? "" : "s")"
    case .extinguished: "just resolved"
    case .touched: "new photo"
    case .idle: "no open issues"
    }
    return "\(slot.title). \(names). \(state)"
  }
}

private struct TightLabel: LabelStyle {
  func makeBody(configuration: Configuration) -> some View {
    HStack(spacing: 3) { configuration.icon; configuration.title }
  }
}

private struct TilePressStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}

private struct TileBadge: View {
  let look: TileLook
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var pop: AnyTransition { reduceMotion ? .opacity : .scale.combined(with: .opacity) }
  var body: some View {
    switch look {
    case .burning(let n):
      StatusPill(text: "\(n)", tone: .critical, systemImage: "flame.fill")
        .transition(pop)
    case .extinguished(let at):
      Image(systemName: "checkmark.circle.fill").font(.body).foregroundStyle(Theme.good)
        .symbolEffect(.bounce, value: at)
        .transition(pop)
    case .touched:
      Image(systemName: "camera.fill").font(.caption).foregroundStyle(Theme.accent)
        .transition(.opacity)
    case .idle:
      EmptyView()
    }
  }
}

/// The tile's fill, border and the fire / extinguish / pulse effects.
private struct TileBackground: View {
  let look: TileLook
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: Theme.radius, style: .continuous) }

  var body: some View {
    switch look {
    case .idle:
      shape.fill(Theme.ground).overlay(shape.strokeBorder(Theme.line, lineWidth: 1))
    case .burning:
      if reduceMotion {
        shape.fill(Theme.criticalBg).overlay(shape.strokeBorder(Theme.critical, lineWidth: 2))
      } else {
        TimelineView(.animation(minimumInterval: 1.0 / 30)) { ctx in
          let t = ctx.date.timeIntervalSinceReferenceDate
          // Two slow sines and a fast one: a soft, irregular flicker rather than a metronome.
          let f = 0.6 + 0.22 * sin(t * 2.1) + 0.1 * sin(t * 5.3 + 1.3) + 0.06 * sin(t * 11.0)
          shape.fill(Theme.criticalBg)
            .overlay(shape.strokeBorder(Theme.critical.opacity(0.55 + 0.45 * f), lineWidth: 1.5))
            .shadow(color: Theme.critical.opacity(0.55 * f), radius: 4 + 10 * f)
        }
      }
    case .extinguished(let at):
      if reduceMotion {
        shape.fill(Theme.goodBg).overlay(shape.strokeBorder(Theme.good, lineWidth: 2))
      } else {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: Date().timeIntervalSince(at) > FloorStore.resolvedLifetime)) { ctx in
          let e = max(0, ctx.date.timeIntervalSince(at))
          let ember = max(0, 1 - e / 0.7)                       // the old glow shrinking away
          let green = e < 14 ? 1 : max(0, 1 - (e - 14) / 6)      // settle to neutral by 20 s
          let p = min(1, e / 1.1)                                // burst progress
          ZStack {
            shape.fill(Theme.ground)
            shape.fill(Theme.goodBg).opacity(green)
            shape.strokeBorder(Theme.line, lineWidth: 1)
            shape.strokeBorder(Theme.good, lineWidth: 1.5).opacity(green)
            if p < 1 {
              Circle().strokeBorder(Theme.good, lineWidth: 2)
                .scaleEffect(0.3 + 1.4 * p).opacity(1 - p)
              ForEach(0..<10, id: \.self) { i in
                let angle = Double(i) / 10 * 2 * .pi
                Circle().fill(i.isMultiple(of: 2) ? Theme.good : Theme.warning)
                  .frame(width: 2 + 4 * (1 - p), height: 2 + 4 * (1 - p))
                  .offset(x: cos(angle) * (18 + 52 * p), y: sin(angle) * (18 + 52 * p))
                  .opacity(1 - p)
              }
            }
          }
          .shadow(color: Theme.critical.opacity(0.5 * ember), radius: 12 * ember)
        }
      }
    case .touched(let at):
      if reduceMotion {
        shape.fill(Theme.ground).overlay(shape.strokeBorder(Theme.accent, lineWidth: 1.5))
      } else {
        TimelineView(.animation(minimumInterval: 1.0 / 30, paused: Date().timeIntervalSince(at) > FloorStore.touchedLifetime)) { ctx in
          let e = max(0, ctx.date.timeIntervalSince(at))
          let fade = max(0, 1 - e / FloorStore.touchedLifetime)
          let pulse = e < 2.4 ? (e.truncatingRemainder(dividingBy: 1.2) / 1.2) : 1
          ZStack {
            shape.fill(Theme.ground)
            shape.fill(Theme.accent.opacity(0.08 * fade))
            shape.strokeBorder(Theme.line, lineWidth: 1)
            shape.strokeBorder(Theme.accent, lineWidth: 1.5).opacity(fade)
            if pulse < 1 {
              shape.strokeBorder(Theme.accent, lineWidth: 2)
                .scaleEffect(1 + 0.12 * pulse).opacity(1 - pulse)
            }
          }
        }
      }
    }
  }
}

// MARK: - Issue list (the map as text)

private struct IssueList: View {
  let store: FloorStore
  let map: FloorMap
  let open: (FloorMap.Slot, FloorAsset?) -> Void
  let confirm: (FloorIssue) -> Void

  var body: some View {
    let openIssues = store.snapshot.openIssues
    let justOut = store.snapshot.issues.filter { store.recentlyResolved[$0.id] != nil }
    Surface(padding: 0) {
      VStack(alignment: .leading, spacing: 0) {
        PanelHead(title: "Open issues", trailing: "\(openIssues.count)")
          .padding(.horizontal, 14).padding(.vertical, 12)
        Divider().overlay(Theme.lineSoft)
        if openIssues.isEmpty && justOut.isEmpty {
          Label("Nothing open on the floor.", systemImage: "checkmark.seal")
            .font(.footnote).foregroundStyle(Theme.ink3)
            .padding(14)
        }
        ForEach(justOut) { issue in
          IssueRow(issue: issue, asset: store.snapshot.asset(forIssue: issue), resolved: true,
                   wearer: store.snapshot.wearerName(issue.deviceId), onTap: tap(issue), onResolve: nil)
          Divider().overlay(Theme.lineSoft)
        }
        ForEach(openIssues) { issue in
          let asset = store.snapshot.asset(forIssue: issue)
          IssueRow(issue: issue, asset: asset, resolved: false,
                   wearer: store.snapshot.wearerName(issue.deviceId), onTap: tap(issue),
                   onResolve: asset == nil ? { confirm(issue) } : nil)
          Divider().overlay(Theme.lineSoft)
        }
      }
    }
    .animation(.easeInOut, value: openIssues.map(\.id))
  }

  private func tap(_ issue: FloorIssue) -> (() -> Void)? {
    guard let asset = store.snapshot.asset(forIssue: issue) else { return nil }
    let slots = map.rows.flatMap { $0.racks + $0.ends } + map.zones.flatMap(\.slots)
    guard let slot = slots.first(where: { $0.assets.contains(asset) }) else { return nil }
    return { open(slot, asset) }
  }
}

private struct IssueRow: View {
  let issue: FloorIssue
  let asset: FloorAsset?
  let resolved: Bool
  let wearer: String
  let onTap: (() -> Void)?
  let onResolve: (() -> Void)?

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Button { onTap?() } label: {
        HStack(alignment: .top, spacing: 10) {
          Image(systemName: resolved ? "checkmark.circle.fill" : "flame.fill")
            .foregroundStyle(resolved ? Theme.good : Theme.critical)
            .frame(width: 20)
          VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 6) {
              Text(asset?.id ?? issue.entityName).font(Theme.mono(13, weight: .semibold)).foregroundStyle(Theme.ink)
              if let asset { Text(asset.location).font(.caption).foregroundStyle(Theme.ink3).lineLimit(1) }
              else { StatusPill(text: "not on map", tone: .neutral) }
            }
            Text(issue.text).font(.footnote).foregroundStyle(resolved ? Theme.ink3 : Theme.ink2)
              .strikethrough(resolved, color: Theme.ink4)
              .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 4) {
              Text(wearer.isEmpty ? issue.wearerName : wearer)
              Text("·")
              Text(issue.at, format: .relative(presentation: .named)).font(Theme.mono(11))
            }
            .font(.caption).foregroundStyle(Theme.ink4)
          }
          Spacer(minLength: 0)
          if onTap != nil { Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.ink4) }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .disabled(onTap == nil)
      .accessibilityLabel("\(resolved ? "Resolved" : "Open"): \(asset?.name ?? issue.entityName). \(issue.text). \(wearer.isEmpty ? issue.wearerName : wearer)")
      .accessibilityHint(onTap == nil ? "" : "Shows it on the map")
      if let onResolve {
        Menu {
          Button("Mark resolved", systemImage: "checkmark.circle", action: onResolve)
        } label: {
          Image(systemName: "ellipsis.circle").frame(width: 44, height: 44)
            .accessibilityLabel("Actions for \(issue.entityName)")
        }
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .frame(minHeight: 44)
  }
}

// MARK: - Resolve confirmation

private struct ResolveConfirmation: ViewModifier {
  let store: FloorStore
  @Binding var issue: FloorIssue?
  @State private var succeeded = 0
  @State private var failed = 0

  func body(content: Content) -> some View {
    content
      .confirmationDialog("Mark this issue resolved?", isPresented: Binding(
        get: { issue != nil }, set: { if !$0 { issue = nil } }),
        titleVisibility: .visible, presenting: issue
      ) { target in
        Button("Mark resolved") {
          Task { if await store.resolve(target) { succeeded += 1 } else { failed += 1 } }
        }
        Button("Cancel", role: .cancel) {}
      } message: { target in
        Text("\(target.entityName): \(target.text)\nEveryone on the shift and the console will see it resolved.")
      }
      .sensoryFeedback(.success, trigger: succeeded)
      .sensoryFeedback(.error, trigger: failed)
  }
}

extension View {
  fileprivate func resolveConfirmation(store: FloorStore, issue: Binding<FloorIssue?>) -> some View {
    modifier(ResolveConfirmation(store: store, issue: issue))
  }
}

// MARK: - Asset sheet

/// One rack (or unit): pick the asset, see what is burning on it, the photos that touched it, and act.
struct AssetSheet: View {
  let store: FloorStore
  let assets: [FloorAsset]
  let onFixWithPhoto: (FloorAsset, FloorIssue?) -> Void
  let onOpenEvent: (String) -> Void

  @State private var selectedId: String
  @State private var confirming: FloorIssue?
  @Environment(\.dismiss) private var dismiss

  init(store: FloorStore, assets: [FloorAsset], initialAssetId: String,
       onFixWithPhoto: @escaping (FloorAsset, FloorIssue?) -> Void, onOpenEvent: @escaping (String) -> Void) {
    self.store = store
    self.assets = assets
    self.onFixWithPhoto = onFixWithPhoto
    self.onOpenEvent = onOpenEvent
    _selectedId = State(initialValue: initialAssetId)
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(spacing: 12) {
          if let error = store.lastError {
            Label(error, systemImage: "exclamationmark.triangle.fill")
              .font(.footnote).foregroundStyle(Theme.criticalInk)
              .frame(maxWidth: .infinity, alignment: .leading)
              .padding(10)
              .background(Theme.criticalBg, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
          }
          if assets.count > 1 {
            Picker("Asset", selection: $selectedId) {
              ForEach(assets) { a in Text(a.id).tag(a.id) }
            }
            .pickerStyle(.segmented)
          }
          if let asset {
            content(for: asset)
          }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
      }
      .background(Theme.page)
      .navigationTitle(asset?.name ?? "Asset")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) { Button("Done") { dismiss() } }
      }
      .resolveConfirmation(store: store, issue: $confirming)
    }
    .presentationDetents([.medium, .large])
    .presentationDragIndicator(.visible)
  }

  private var asset: FloorAsset? { assets.first { $0.id == selectedId } ?? assets.first }

  @ViewBuilder private func content(for asset: FloorAsset) -> some View {
    let state = store.state(for: asset)
    let all = store.issues(for: asset)
    let open = all.filter { !$0.isResolved }.sorted { $0.at > $1.at }
    let resolved = all.filter(\.isResolved).sorted { ($0.resolvedAt ?? $0.at) > ($1.resolvedAt ?? $1.at) }
    let events = store.snapshot.events(for: asset)

    Surface {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline) {
          Label(asset.name, systemImage: floorSymbol(forType: asset.type))
            .font(.headline).foregroundStyle(Theme.ink)
          Spacer()
          switch state {
          case .burning(let issues): StatusPill(text: "\(issues.count) open", tone: .critical, systemImage: "flame.fill")
          case .extinguished: StatusPill(text: "just resolved", tone: .good, systemImage: "checkmark.circle.fill")
          case .touched: StatusPill(text: "new photo", tone: .accent, systemImage: "camera.fill")
          case .idle: StatusPill(text: "clear", tone: .neutral)
          }
        }
        HStack(spacing: 6) {
          Text(asset.id).font(Theme.mono(12, weight: .medium)).foregroundStyle(Theme.ink2)
          Text("·").foregroundStyle(Theme.ink4)
          Label(asset.location.isEmpty ? "Unplaced" : asset.location, systemImage: "mappin.and.ellipse")
            .font(.footnote).foregroundStyle(Theme.ink3)
          Text("·").foregroundStyle(Theme.ink4)
          Text(asset.type).font(.footnote).foregroundStyle(Theme.ink3)
        }
        Button {
          onFixWithPhoto(asset, open.first)
        } label: {
          Label(open.isEmpty ? "Photograph this asset" : "Fix with a photo", systemImage: "camera.viewfinder")
        }
        .buttonStyle(InkButtonStyle())
        .padding(.top, 4)
        .accessibilityHint("Labels the next capture with \(asset.id) and starts narration")
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    }

    if !open.isEmpty {
      Surface(padding: 0) {
        VStack(alignment: .leading, spacing: 0) {
          PanelHead(title: "Open issues", trailing: "\(open.count)").padding(14)
          ForEach(open) { issue in
            Divider().overlay(Theme.lineSoft)
            issueBlock(issue, resolved: false)
          }
        }
      }
    }

    if !resolved.isEmpty {
      Surface(padding: 0) {
        VStack(alignment: .leading, spacing: 0) {
          PanelHead(title: "Resolved", trailing: "\(resolved.count)").padding(14)
          ForEach(resolved.prefix(5)) { issue in
            Divider().overlay(Theme.lineSoft)
            issueBlock(issue, resolved: true)
          }
        }
      }
    }

    Surface(padding: 0) {
      VStack(alignment: .leading, spacing: 0) {
        PanelHead(title: "Recent photos", trailing: events.isEmpty ? nil : "\(events.count)").padding(14)
        if events.isEmpty {
          Divider().overlay(Theme.lineSoft)
          Text("No photos of this asset in the last day and a half.")
            .font(.footnote).foregroundStyle(Theme.ink3).padding(14)
        }
        ForEach(events.prefix(20)) { event in
          Divider().overlay(Theme.lineSoft)
          Button { onOpenEvent(event.id) } label: {
            HStack(alignment: .top, spacing: 10) {
              VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                  Text(event.at, format: .dateTime.hour().minute().second())
                    .font(Theme.mono(12)).foregroundStyle(Theme.ink2)
                  Text(store.snapshot.wearerName(event.deviceId)).font(.caption).foregroundStyle(Theme.ink3)
                  if let label = event.label {
                    Text(label).font(.caption.weight(.medium)).foregroundStyle(Theme.entity).lineLimit(1)
                  }
                }
                Text(event.summary.isEmpty ? "Processing…" : event.summary)
                  .font(.footnote).foregroundStyle(event.summary.isEmpty ? Theme.ink4 : Theme.ink2)
                  .lineLimit(3)
                if let note = event.note {
                  Label(note, systemImage: "text.bubble").font(.caption).foregroundStyle(Theme.ink3).lineLimit(2)
                }
              }
              Spacer(minLength: 0)
              Image(systemName: "chevron.right").font(.caption).foregroundStyle(Theme.ink4)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(minHeight: 44)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
        }
      }
    }
  }

  @ViewBuilder private func issueBlock(_ issue: FloorIssue, resolved: Bool) -> some View {
    let raising = store.snapshot.events.first { $0.id == issue.eventId }
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: resolved ? "checkmark.circle.fill" : "flame.fill")
          .foregroundStyle(resolved ? Theme.good : Theme.critical)
        Text(issue.text).font(.subheadline).foregroundStyle(Theme.ink)
          .fixedSize(horizontal: false, vertical: true)
      }
      HStack(spacing: 4) {
        StatusPill(text: issue.kind.replacingOccurrences(of: "_", with: " "), tone: resolved ? .neutral : .critical)
        Text(store.snapshot.wearerName(issue.deviceId))
        Text("·")
        Text(issue.at, format: .dateTime.hour().minute()).font(Theme.mono(11))
        if resolved, let at = issue.resolvedAt {
          Text("· resolved")
          Text(at, format: .dateTime.hour().minute()).font(Theme.mono(11))
        }
      }
      .font(.caption).foregroundStyle(Theme.ink3)
      if let raising {
        Button { onOpenEvent(raising.id) } label: {
          HStack(alignment: .top, spacing: 6) {
            Image(systemName: "photo").foregroundStyle(Theme.ink4)
            Text(raising.summary.isEmpty ? "The photo that raised it" : raising.summary)
              .font(.footnote).foregroundStyle(Theme.ink2).lineLimit(3)
              .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
          }
          .padding(8)
          .frame(minHeight: 44)
          .background(Theme.panel, in: RoundedRectangle(cornerRadius: Theme.radiusSmall, style: .continuous))
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Photo that raised it: \(raising.summary)")
      }
      if !resolved {
        Button { confirming = issue } label: {
          Label("Mark resolved", systemImage: "checkmark.circle")
        }
        .buttonStyle(InkButtonStyle(prominent: false))
      }
    }
    .padding(14)
  }
}
