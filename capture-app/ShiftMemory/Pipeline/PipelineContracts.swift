//
// PipelineContracts.swift
// Shift Memory
//
// What happens to a photo between the glasses and the upload: decode (JPEG or HEIC), honor the
// EXIF orientation, read DateTimeOriginal, resize to 1600 px on the long edge, blur every face
// (Vision face rectangles), re-encode as JPEG ~q0.85 with no metadata, and make a 320 px thumbnail.
//

import CoreGraphics
import Foundation

enum ImageFormat: String, Codable, Sendable {
  case jpeg, heic, png, unknown

  /// Sniffs the container from the first bytes: JPEG `FF D8`, HEIC/HEIF `ftyp` at offset 4, PNG signature.
  static func sniff(_ data: Data) -> ImageFormat {
    guard data.count >= 12 else { return .unknown }
    let b = [UInt8](data.prefix(12))
    if b[0] == 0xFF, b[1] == 0xD8 { return .jpeg }
    if b[0] == 0x89, b[1] == 0x50, b[2] == 0x4E, b[3] == 0x47 { return .png }
    if b[4] == 0x66, b[5] == 0x74, b[6] == 0x79, b[7] == 0x70 { return .heic } // "ftyp"
    return .unknown
  }
}

struct PipelineOptions: Sendable, Equatable {
  var longEdge: Int = 1600
  var jpegQuality: CGFloat = 0.85
  var blurFaces: Bool = true
  var thumbnailLongEdge: Int = 320

  static let standard = PipelineOptions()
}

struct PreparedPhoto: Sendable {
  /// The upload: JPEG, long edge ≤ `longEdge`, faces blurred, no EXIF/GPS.
  let jpeg: Data
  let width: Int
  let height: Int
  /// Small JPEG for the phone's own list; never uploaded.
  let thumbnail: Data
  let originalFormat: ImageFormat
  let originalPixelWidth: Int
  let originalPixelHeight: Int
  /// EXIF DateTimeOriginal (+ OffsetTimeOriginal when present), if the source carried it.
  let exifDate: Date?
  let exifOffsetSeconds: Int?
  let facesBlurred: Int
  let processingMs: Int
}

enum PipelineError: Error, Sendable, Equatable {
  case undecodable
  case encodingFailed
}

protocol ImagePipelineProtocol: Sendable {
  /// Runs off the main actor; safe to call from anywhere. Pure: no disk, no network.
  func prepare(_ data: Data, options: PipelineOptions) async throws(PipelineError) -> PreparedPhoto
}
