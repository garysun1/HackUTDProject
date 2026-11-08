//
// IngestContracts.swift
// Shift Memory
//
// The phone ↔ module interface as Swift types. Transport details are in docs/CONTRACT.md:
//   POST {host}/v1/database/{db}/call/ingest_photo   body: ["<event_json>", "<photo_b64>"]
//   POST {host}/v1/database/{db}/call/ping            body: []
//   POST {host}/v1/database/{db}/sql                  body (text/plain): SELECT status, summary FROM event WHERE event_id = '…'
// The module returns camelCase keys (`eventId`, `serverT`, `status`); the contract document shows
// snake_case. Decoders accept both.
//

import Foundation

struct IngestResult: Sendable, Equatable {
  let eventId: String
  let serverT: Date?
  let serverTRaw: String
  /// `accepted` | `duplicate` (anything else is passed through)
  let status: String
}

struct PingResult: Sendable, Equatable {
  let serverT: Date
  let serverTRaw: String
  /// Phone clock minus server clock at the moment the reply was parsed, in milliseconds.
  let clockOffsetMs: Int
  let roundTripMs: Int
}

struct EventStatusRow: Sendable, Equatable {
  /// `accepted` | `perceived` | `in_graph` | `duplicate` | `failed`
  let status: String
  let summary: String
}

enum IngestError: Error, Sendable, Equatable {
  /// The module rejected the shared secret. Never retried; the user must fix Settings.
  case invalidToken
  /// The module rejected the payload (`missing_*`, `invalid_event_json`, `missing_photo`). Never retried.
  case badRequest(String)
  /// Any other HTTP status. 5xx and 429 are retried with backoff; other 4xx are not.
  case http(status: Int, body: String)
  /// URLSession failed (offline, DNS, timeout). Retried.
  case network(String)
  /// The reply was not the JSON we expect. Retried a bounded number of times.
  case decoding(String)
  case notConfigured(String)

  var isRetryable: Bool {
    switch self {
    case .invalidToken, .badRequest, .notConfigured: false
    case .http(let status, _): status >= 500 || status == 429 || status == 408
    case .network, .decoding: true
    }
  }

  var userMessage: String {
    switch self {
    case .invalidToken: "The backend rejected the ingest token. Check Settings."
    case .badRequest(let why): "The backend rejected the event: \(why)."
    case .http(let status, _): "Backend error HTTP \(status). Retrying."
    case .network(let why): "No connection: \(why)"
    case .decoding(let why): "Unexpected reply from the backend: \(why)"
    case .notConfigured(let what): "\(what) is not set. Open Settings."
    }
  }
}

/// Everything the upload path needs from the backend. `IngestClient` is the live implementation;
/// tests substitute a stub.
protocol IngestClientProtocol: Sendable {
  func ping() async throws(IngestError) -> PingResult
  func ingest(eventJSON: String, photoBase64: String) async throws(IngestError) -> IngestResult
  func status(eventId: String) async throws(IngestError) -> EventStatusRow?
  /// Reducers `set_label` / `set_note`: POST {host}/v1/database/{db}/call/set_label with
  /// body `["<event_id>", "<label>"]`; an empty 2xx body means success.
  func setLabel(eventId: String, label: String) async throws(IngestError)
  func setNote(eventId: String, note: String) async throws(IngestError)
}

/// Where the backend lives. Read from AppConfig at call time so Settings edits apply immediately.
struct BackendEndpoint: Sendable, Equatable {
  var host: String       // e.g. https://maincloud.spacetimedb.com (no trailing slash)
  var database: String   // e.g. wm-physical

  var isConfigured: Bool { !host.isEmpty && !database.isEmpty && URL(string: host) != nil }
  func procedureURL(_ name: String) -> URL? {
    URL(string: "\(host.trimmingTrailingSlash)/v1/database/\(database)/call/\(name)")
  }
  var sqlURL: URL? { URL(string: "\(host.trimmingTrailingSlash)/v1/database/\(database)/sql") }
  /// Module schema (procedures appear under `misc_exports`, reducers under `reducers`).
  var schemaURL: URL? { URL(string: "\(host.trimmingTrailingSlash)/v1/database/\(database)/schema?version=9") }
}

extension String {
  var trimmingTrailingSlash: String {
    var s = self
    while s.hasSuffix("/") { s.removeLast() }
    return s
  }
}
