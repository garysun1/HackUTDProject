//
// EventStore.swift
// Shift Memory
//
// The phone's own memory of its events: the list the UI shows, the uploaded JPEG and a thumbnail
// per event, and the live stage of each one as the upload queue reports it. Persisted as JSON in
// Application Support; capped at the last 200 events. The upload queue keeps its own pending copy
// of a photo until the module accepts it; this store keeps the copy the wearer looks at.
//

import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class EventStore {
  private(set) var events: [CaptureEvent] = []   // newest first
  private(set) var pendingCount = 0
  var lastPing: PingResult?
  /// nil until the first ping; then whether the backend answered.
  var backendReachable: Bool?
  var lastBackendError: String?

  private let directory: URL
  private var thumbnails: [String: UIImage] = [:]
  private var saveTask: Task<Void, Never>?
  private let cap = 200

  init(directory: URL) {
    self.directory = directory
    for sub in ["photos", "thumbs"] {
      try? FileManager.default.createDirectory(at: directory.appending(path: sub), withIntermediateDirectories: true)
    }
    load()
  }

  // MARK: - Reads

  func event(id: String) -> CaptureEvent? { events.first { $0.id == id } }

  func thumbnail(for id: String) -> UIImage? {
    if let t = thumbnails[id] { return t }
    guard let data = try? Data(contentsOf: thumbURL(id)), let img = UIImage(data: data) else { return nil }
    thumbnails[id] = img
    return img
  }

  func photo(for id: String) -> UIImage? {
    guard let data = try? Data(contentsOf: photoURL(id)) else { return thumbnail(for: id) }
    return UIImage(data: data)
  }

  var liveCount: Int { events.filter { !$0.stage.isTerminal && !$0.stage.isPendingUpload }.count }

  // MARK: - Writes

  func add(_ event: CaptureEvent, jpeg: Data, thumbnail: Data) {
    try? jpeg.write(to: photoURL(event.id), options: .atomic)
    try? thumbnail.write(to: thumbURL(event.id), options: .atomic)
    events.insert(event, at: 0)
    trim()
    scheduleSave()
  }

  func update(id: String, _ mutate: (inout CaptureEvent) -> Void) {
    guard let i = events.firstIndex(where: { $0.id == id }) else { return }
    mutate(&events[i])
    scheduleSave()
  }

  func remove(id: String) {
    events.removeAll { $0.id == id }
    thumbnails[id] = nil
    try? FileManager.default.removeItem(at: photoURL(id))
    try? FileManager.default.removeItem(at: thumbURL(id))
    scheduleSave()
  }

  /// Mirror what the upload queue reports.
  func apply(_ update: UploadQueue.Update) {
    switch update {
    case let .stage(eventId, stage, serverT, error, attempts):
      self.update(id: eventId) { e in
        e.stage = stage
        e.attempts = attempts
        e.lastError = error
        if let serverT { e.serverT = serverT }
        if stage == .accepted, e.acceptedAt == nil { e.acceptedAt = Date() }
        if stage == .duplicate, e.acceptedAt == nil { e.acceptedAt = Date() }
      }
    case let .polled(eventId, status, summary):
      self.update(id: eventId) { e in
        if !summary.isEmpty { e.summary = summary }
        switch status {
        case "in_graph":
          e.stage = .inGraph
          if e.inGraphAt == nil { e.inGraphAt = Date() }
        case "failed":
          e.stage = .failed
          e.lastError = "The module could not read this photo."
        case "duplicate": e.stage = .duplicate
        case "perceived", "accepted": if e.stage != .inGraph { e.stage = .accepted }
        default: break
        }
      }
    case let .depth(pending):
      pendingCount = pending
    }
  }

  // MARK: - Persistence

  private var indexURL: URL { directory.appending(path: "events.json") }
  private func photoURL(_ id: String) -> URL { directory.appending(path: "photos/\(id).jpg") }
  private func thumbURL(_ id: String) -> URL { directory.appending(path: "thumbs/\(id).thumb.jpg") }

  private func load() {
    guard let data = try? Data(contentsOf: indexURL) else { return }
    let decoder = JSONDecoder()
    decoder.dateDecodingStrategy = .iso8601
    if let decoded = try? decoder.decode([CaptureEvent].self, from: data) {
      // Anything that was mid-upload when the app died is back in the queue's hands.
      events = decoded.map { e in
        var e = e
        if e.stage == .uploading || e.stage == .processing { e.stage = .queued }
        return e
      }
    }
  }

  private func trim() {
    guard events.count > cap else { return }
    for e in events[cap...] {
      thumbnails[e.id] = nil
      try? FileManager.default.removeItem(at: photoURL(e.id))
      try? FileManager.default.removeItem(at: thumbURL(e.id))
    }
    events.removeLast(events.count - cap)
  }

  private func scheduleSave() {
    saveTask?.cancel()
    saveTask = Task { [weak self] in
      try? await Task.sleep(for: .milliseconds(300))
      guard !Task.isCancelled, let self else { return }
      let encoder = JSONEncoder()
      encoder.dateEncodingStrategy = .iso8601
      encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
      if let data = try? encoder.encode(self.events) {
        try? data.write(to: self.indexURL, options: .atomic)
      }
    }
  }
}
