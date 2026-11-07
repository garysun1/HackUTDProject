//
// IngestClient.swift
// Shift Memory
//
// The live HTTP transport to the SpacetimeDB module on Maincloud: `ping`, `ingest_photo`, the
// SQL status poll, and the `set_label` / `set_note` reducers, exactly as docs/CONTRACT.md and
// module/spacetimedb/src/index.ts describe them. The endpoint is read at call time so a Settings
// edit applies to the next request, and every failure is folded into one `IngestError` case so
// the upload queue can choose between retrying and giving up without looking at HTTP itself.
//

import Foundation

// MARK: - IngestClient

final class IngestClient: IngestClientProtocol, Sendable {
  private let endpoint: @Sendable () -> BackendEndpoint
  private let session: URLSession

  /// Procedure calls other than the upload are tiny; the upload carries ~650 KB of base64 and
  /// may ride a weak cellular link, so it gets a full minute.
  private static let callTimeout: TimeInterval = 15
  private static let ingestTimeout: TimeInterval = 60

  init(endpoint: @escaping @Sendable () -> BackendEndpoint, session: URLSession = .shared) {
    self.endpoint = endpoint
    self.session = session
  }

  // MARK: - IngestClientProtocol

  func ping() async throws(IngestError) -> PingResult {
    let request = try procedureRequest("ping", arguments: [], timeout: Self.callTimeout)
    let sentAt = Date()
    let reply = try await send(request)
    let receivedAt = Date()
    guard let object = Self.jsonObject(reply.body, positional: ["serverT", "tMicros"]),
          let raw = Self.string(object, "serverT", "server_t"),
          let serverT = ISO8601Dates.parse(raw)
    else { throw .decoding("ping reply: \(Self.excerpt(reply.body))") }

    // The server stamped its clock roughly halfway through the round trip, so compare it with
    // the phone's clock at that midpoint rather than at receipt.
    let roundTrip = receivedAt.timeIntervalSince(sentAt)
    let phoneAtStamp = receivedAt.addingTimeInterval(-roundTrip / 2)
    return PingResult(
      serverT: serverT,
      serverTRaw: raw,
      clockOffsetMs: Int((phoneAtStamp.timeIntervalSince(serverT) * 1000).rounded()),
      roundTripMs: Int((roundTrip * 1000).rounded())
    )
  }

  func ingest(eventJSON: String, photoBase64: String) async throws(IngestError) -> IngestResult {
    let request = try procedureRequest("ingest_photo", arguments: [eventJSON, photoBase64], timeout: Self.ingestTimeout)
    let reply = try await send(request)
    guard let object = Self.jsonObject(reply.body, positional: ["eventId", "serverT", "status"]),
          let eventId = Self.string(object, "eventId", "event_id"),
          let status = Self.string(object, "status")
    else { throw .decoding("ingest_photo reply: \(Self.excerpt(reply.body))") }
    let raw = Self.string(object, "serverT", "server_t") ?? ""
    return IngestResult(eventId: eventId, serverT: ISO8601Dates.parse(raw), serverTRaw: raw, status: status)
  }

  func status(eventId: String) async throws(IngestError) -> EventStatusRow? {
    let current = endpoint()
    guard current.isConfigured, let url = current.sqlURL else { throw .notConfigured("Backend") }
    var request = URLRequest(url: url, timeoutInterval: Self.callTimeout)
    request.httpMethod = "POST"
    request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
    // Event ids are our own lowercase UUIDs; stripping quotes keeps a stray id from breaking the SQL.
    let safeId = eventId.replacingOccurrences(of: "'", with: "")
    request.httpBody = Data("SELECT status, summary FROM event WHERE event_id = '\(safeId)'".utf8)

    let reply = try await send(request)
    // One result set per statement, each with `rows` as arrays of column values.
    guard let resultSets = (try? JSONSerialization.jsonObject(with: reply.body)) as? [[String: Any]] else {
      throw .decoding("sql reply: \(Self.excerpt(reply.body))")
    }
    guard let first = resultSets.first else { return nil }
    guard let rows = first["rows"] as? [[Any]] else { throw .decoding("sql reply without rows: \(Self.excerpt(reply.body))") }
    guard let row = rows.first else { return nil }
    guard let status = row.first as? String else { throw .decoding("sql row without a status: \(row)") }
    let summary = row.count > 1 ? (row[1] as? String ?? "") : ""
    return EventStatusRow(status: status, summary: summary)
  }

  func setLabel(eventId: String, label: String) async throws(IngestError) {
    let request = try procedureRequest("set_label", arguments: [eventId, label], timeout: Self.callTimeout)
    _ = try await send(request)
  }

  func setNote(eventId: String, note: String) async throws(IngestError) {
    let request = try procedureRequest("set_note", arguments: [eventId, note], timeout: Self.callTimeout)
    _ = try await send(request)
  }

  // MARK: - Requests

  /// `POST {host}/v1/database/{db}/call/{name}` with the arguments as a JSON array of strings.
  /// `event_json` is itself JSON text and travels as one string element, never merged in.
  private func procedureRequest(_ name: String, arguments: [String], timeout: TimeInterval) throws(IngestError) -> URLRequest {
    let current = endpoint()
    guard current.isConfigured, let url = current.procedureURL(name) else { throw .notConfigured("Backend") }
    guard let body = try? JSONSerialization.data(withJSONObject: arguments, options: [.withoutEscapingSlashes]) else {
      throw .decoding("could not encode the \(name) arguments")
    }
    var request = URLRequest(url: url, timeoutInterval: timeout)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = body
    return request
  }

  /// Performs the request; anything that is not a 2xx comes back as an `IngestError`.
  private func send(_ request: URLRequest) async throws(IngestError) -> (status: Int, body: Data) {
    let result: (Data, URLResponse)
    do {
      result = try await session.data(for: request)
    } catch {
      // Offline, DNS, timeout, cancelled: URLError's own wording is what the user should read.
      throw .network(error.localizedDescription)
    }
    let (body, response) = result
    guard let http = response as? HTTPURLResponse else { throw .decoding("not an HTTP response") }
    guard (200..<300).contains(http.statusCode) else { throw Self.failure(status: http.statusCode, body: body) }
    return (http.statusCode, body)
  }

  // MARK: - Error mapping

  /// The module raises `SenderError('<code>')` for validation failures. Observed on Maincloud: the
  /// HTTP `/call` endpoint answers **500** with the body
  /// `The module instance encountered a fatal error: invalid_token`, so the code in the body, not the
  /// status, decides. A rejected token or payload is permanent; anything else goes through
  /// `IngestError.isRetryable`.
  private static func failure(status: Int, body: Data) -> IngestError {
    let text = excerpt(body)
    if text.contains("invalid_token") || text.contains("unauthorized") { return .invalidToken }
    if text.contains("missing_") || text.contains("invalid_event_json") || text.contains("not_found") {
      return .badRequest(text)
    }
    return .http(status: status, body: text)
  }

  /// The body as trimmed text, capped so a proxy's HTML error page cannot flood a label or a log.
  private static func excerpt(_ body: Data) -> String {
    let text = String(decoding: body, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    return text.count > 500 ? String(text.prefix(500)) : text
  }

  // MARK: - JSON helpers

  /// The HTTP `/call` endpoint returns a procedure's product type as a positional JSON array
  /// (`["2026-…Z","1794…"]` for `Pong`), while the docs show it as an object. Accept both: an array is
  /// zipped onto the module's field order in `positional`.
  static func jsonObject(_ data: Data, positional: [String]) -> [String: Any]? {
    guard let any = try? JSONSerialization.jsonObject(with: data) else { return nil }
    if let object = any as? [String: Any] { return object }
    if let array = any as? [Any] {
      var object: [String: Any] = [:]
      for (name, value) in zip(positional, array) { object[name] = value }
      return object
    }
    return nil
  }

  /// The first string present under any of the spellings (the module answers camelCase, the
  /// contract document shows snake_case).
  private static func string(_ object: [String: Any], _ keys: String...) -> String? {
    for key in keys {
      if let value = object[key] as? String { return value }
    }
    return nil
  }
}

// MARK: - ISO-8601 dates

/// Reads and writes the timestamps that cross the wire or the disk: the module's `toISOString()`
/// always carries milliseconds and `Z`, the contract's examples carry a UTC offset, and the upload
/// queue persists its dates in the same shape so `client_t` survives a relaunch to the millisecond.
enum ISO8601Dates {
  static func parse(_ string: String) -> Date? {
    let fractional = ISO8601DateFormatter()
    fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = fractional.date(from: string) { return date }
    let whole = ISO8601DateFormatter()
    whole.formatOptions = [.withInternetDateTime]
    return whole.date(from: string)
  }

  static func string(_ date: Date) -> String {
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return formatter.string(from: date)
  }
}
