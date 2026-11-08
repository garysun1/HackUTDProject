//
// ElevenLabsClient.swift
// Shift Memory
//
// ElevenLabs text-to-speech: one POST per line, MP3 back. The key and the voice id come from
// Settings (Keychain / defaults); `BriefingSpeaker` plays the bytes.
//

import Foundation

struct ElevenLabsError: Error, CustomStringConvertible, Equatable {
  enum Kind: Equatable { case noKey, http(Int), transport, badReply }
  let kind: Kind
  let detail: String
  var description: String {
    switch kind {
    case .noKey: "No ElevenLabs API key is set (Settings → Voice and briefing)."
    case .http(let status): "ElevenLabs replied \(status): \(detail)"
    case .transport: "Could not reach ElevenLabs: \(detail)"
    case .badReply: "ElevenLabs sent an unexpected reply: \(detail)"
    }
  }
}

final class ElevenLabsClient: Sendable {
  static let base = URL(string: "https://api.elevenlabs.io/v1/text-to-speech/")!
  /// "George": calm, clear, English. Any voice id from the ElevenLabs library works.
  static let defaultVoiceId = "JBFqnCBsd6RMkjVDRZzb"
  static let model = "eleven_flash_v2_5"
  static let outputFormat = "mp3_44100_128"

  private let apiKey: @Sendable () -> String
  private let voiceId: @Sendable () -> String
  private let session: URLSession

  init(apiKey: @escaping @Sendable () -> String, voiceId: @escaping @Sendable () -> String, session: URLSession = .shared) {
    self.apiKey = apiKey
    self.voiceId = voiceId
    self.session = session
  }

  var hasKey: Bool { !apiKey().trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

  /// MP3 bytes for `text`.
  func synthesize(_ text: String) async throws(ElevenLabsError) -> Data {
    let key = apiKey().trimmingCharacters(in: .whitespacesAndNewlines)
    guard !key.isEmpty else { throw ElevenLabsError(kind: .noKey, detail: "") }
    var voice = voiceId().trimmingCharacters(in: .whitespacesAndNewlines)
    if voice.isEmpty { voice = Self.defaultVoiceId }
    var components = URLComponents(url: Self.base.appending(path: voice), resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "output_format", value: Self.outputFormat)]
    var request = URLRequest(url: components.url!)
    request.httpMethod = "POST"
    request.timeoutInterval = 30
    request.setValue(key, forHTTPHeaderField: "xi-api-key")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("audio/mpeg", forHTTPHeaderField: "Accept")
    request.httpBody = Self.requestBody(text: text)
    let data: Data
    let status: Int
    do {
      let (d, response) = try await session.data(for: request)
      guard let http = response as? HTTPURLResponse else { throw ElevenLabsError(kind: .badReply, detail: "not an HTTP response") }
      data = d
      status = http.statusCode
    } catch let error as ElevenLabsError {
      throw error
    } catch {
      throw ElevenLabsError(kind: .transport, detail: error.localizedDescription)
    }
    guard (200..<300).contains(status) else {
      throw ElevenLabsError(kind: .http(status), detail: String(decoding: data.prefix(300), as: UTF8.self))
    }
    guard Self.looksLikeMP3(data) else {
      throw ElevenLabsError(kind: .badReply, detail: String(decoding: data.prefix(200), as: UTF8.self))
    }
    return data
  }

  static func requestBody(text: String) -> Data {
    let payload: [String: Any] = [
      "text": String(text.prefix(4_000)),
      "model_id": model,
      "voice_settings": ["stability": 0.5, "similarity_boost": 0.75, "speed": 0.95],
    ]
    return (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
  }

  /// ID3 tag or an MPEG frame sync at the start.
  static func looksLikeMP3(_ data: Data) -> Bool {
    guard data.count > 4 else { return false }
    if data.prefix(3) == Data("ID3".utf8) { return true }
    return data[data.startIndex] == 0xFF && (data[data.startIndex + 1] & 0xE0) == 0xE0
  }
}
