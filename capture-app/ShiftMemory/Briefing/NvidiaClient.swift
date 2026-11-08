//
// NvidiaClient.swift
// Shift Memory
//
// The phone's own line to NVIDIA: Nemotron (OpenAI-compatible chat completions on
// integrate.api.nvidia.com) writes the spoken briefing and grades the wearer's repeat-back; Magpie
// TTS (the hosted NIM on nvcf) turns text into a WAV. One key for both, kept in the Keychain. Pure
// transport: prompts live in `BriefingSynthesis`, playback in `BriefingSpeaker`.
//

import Foundation

struct NvidiaError: Error, CustomStringConvertible, Equatable {
  enum Kind: Equatable { case noKey, http(Int), transport, badReply, timedOut }
  let kind: Kind
  let detail: String

  var description: String {
    switch kind {
    case .noKey: "No NVIDIA API key is set (Settings → Voice and briefing)."
    case .http(let status): "NVIDIA replied \(status): \(detail)"
    case .transport: "Could not reach NVIDIA: \(detail)"
    case .badReply: "NVIDIA sent an unexpected reply: \(detail)"
    case .timedOut: "NVIDIA took too long: \(detail)"
    }
  }
}

final class NvidiaClient: Sendable {
  static let chatURL = URL(string: "https://integrate.api.nvidia.com/v1/chat/completions")!
  /// Magpie TTS multilingual, hosted function (build.nvidia.com/nvidia/magpie-tts-multilingual).
  static let ttsURL = URL(string: "https://877104f7-e885-42b9-8de8-f6e4c6303969.invocation.api.nvcf.nvidia.com/v1/audio/synthesize")!
  static let pollURL = URL(string: "https://api.nvcf.nvidia.com/v2/nvcf/pexec/status/")!
  static let textModel = "nvidia/nemotron-3.5-lightning-30b-a3b"
  static let defaultVoice = "Magpie-Multilingual.EN-US.Aria"
  static let sampleRate = 22_050

  private let apiKey: @Sendable () -> String
  private let session: URLSession

  init(apiKey: @escaping @Sendable () -> String, session: URLSession = .shared) {
    self.apiKey = apiKey
    self.session = session
  }

  var hasKey: Bool { !apiKey().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  // MARK: Nemotron

  /// One non-thinking completion; returns the assistant text.
  func complete(system: String, user: String, maxTokens: Int = 500, temperature: Double = 0.3) async throws(NvidiaError) -> String {
    let key = apiKey().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else { throw NvidiaError(kind: .noKey, detail: "") }
    let payload: [String: Any] = [
      "model": Self.textModel,
      "messages": [
        ["role": "system", "content": system],
        ["role": "user", "content": user],
      ],
      "temperature": temperature,
      "max_tokens": maxTokens,
      "chat_template_kwargs": ["enable_thinking": false],
    ]
    var request = URLRequest(url: Self.chatURL)
    request.httpMethod = "POST"
    request.timeoutInterval = 40
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = try? JSONSerialization.data(withJSONObject: payload)
    let (data, status) = try await send(request)
    guard (200..<300).contains(status) else { throw NvidiaError(kind: .http(status), detail: Self.excerpt(data)) }
    guard let text = Self.contentText(from: data) else { throw NvidiaError(kind: .badReply, detail: Self.excerpt(data)) }
    return text
  }

  /// `choices[0].message.content`, with any `<think>…</think>` block removed.
  static func contentText(from data: Data) -> String? {
    guard let any = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let choices = any["choices"] as? [[String: Any]],
          let message = choices.first?["message"] as? [String: Any],
          let content = message["content"] as? String else { return nil }
    return stripThinking(content).trimmingCharacters(in: .whitespacesAndNewlines)
  }

  static func stripThinking(_ s: String) -> String {
    guard let open = s.range(of: "<think>"), let close = s.range(of: "</think>", range: open.upperBound..<s.endIndex) else { return s }
    return String(s[..<open.lowerBound]) + String(s[close.upperBound...])
  }

  // MARK: Magpie TTS

  /// Speech for `text` as a WAV (LINEAR_PCM, mono, `sampleRate`).
  func synthesize(_ text: String, voice: String = NvidiaClient.defaultVoice) async throws(NvidiaError) -> Data {
    let key = apiKey().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else { throw NvidiaError(kind: .noKey, detail: "") }
    let boundary = "ShiftMemory-\(UUID().uuidString)"
    var request = URLRequest(url: Self.ttsURL)
    request.httpMethod = "POST"
    request.timeoutInterval = 40
    request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    request.setValue("audio/wav, application/octet-stream, application/json", forHTTPHeaderField: "Accept")
    request.httpBody = Self.multipartBody(fields: [
      ("text", String(text.prefix(1_900))),
      ("language", "en-US"),
      ("voice", voice),
      ("encoding", "LINEAR_PCM"),
      ("sample_rate_hz", String(Self.sampleRate)),
    ], boundary: boundary)
    var (data, status, headers) = try await sendWithHeaders(request)
    // nvcf answers 202 + NVCF-REQID while the function is still working; poll until the body arrives.
    var polls = 0
    while status == 202, polls < 20 {
      guard let reqId = headers["NVCF-REQID"] ?? headers["nvcf-reqid"] else { break }
      try? await Task.sleep(for: .milliseconds(600))
      var poll = URLRequest(url: Self.pollURL.appending(path: reqId))
      poll.timeoutInterval = 30
      poll.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
      (data, status, headers) = try await sendWithHeaders(poll)
      polls += 1
    }
    guard status != 202 else { throw NvidiaError(kind: .timedOut, detail: "speech was still rendering after \(polls) polls") }
    guard (200..<300).contains(status) else { throw NvidiaError(kind: .http(status), detail: Self.excerpt(data)) }
    guard Self.looksLikeWav(data) else { throw NvidiaError(kind: .badReply, detail: Self.excerpt(data)) }
    return data
  }

  static func looksLikeWav(_ data: Data) -> Bool {
    data.count > 44 && data.prefix(4) == Data("RIFF".utf8) && data[8..<12] == Data("WAVE".utf8)
  }

  static func multipartBody(fields: [(String, String)], boundary: String) -> Data {
    var body = Data()
    for (name, value) in fields {
      body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
    }
    body.append(Data("--\(boundary)--\r\n".utf8))
    return body
  }

  // MARK: Transport

  private func send(_ request: URLRequest) async throws(NvidiaError) -> (Data, Int) {
    let (data, status, _) = try await sendWithHeaders(request)
    return (data, status)
  }

  private func sendWithHeaders(_ request: URLRequest) async throws(NvidiaError) -> (Data, Int, [String: String]) {
    do {
      let (data, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { throw NvidiaError(kind: .badReply, detail: "not an HTTP response") }
      var headers: [String: String] = [:]
      for (k, v) in http.allHeaderFields { if let k = k as? String, let v = v as? String { headers[k] = v } }
      return (data, http.statusCode, headers)
    } catch let error as NvidiaError {
      throw error
    } catch {
      if (error as? URLError)?.code == .timedOut { throw NvidiaError(kind: .timedOut, detail: error.localizedDescription) }
      throw NvidiaError(kind: .transport, detail: error.localizedDescription)
    }
  }

  private static func excerpt(_ data: Data) -> String {
    String(decoding: data.prefix(300), as: UTF8.self).replacingOccurrences(of: "\n", with: " ")
  }
}
