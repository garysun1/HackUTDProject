//
// ImagePipeline.swift
// Shift Memory
//
// The photo path between the glasses and the upload. One call takes whatever ImageIO can read
// (JPEG or HEIC straight from the glasses, PNG from a manual upload), notes the original size and
// the EXIF capture time, decodes straight to an upright 1600 px image without ever holding the
// full-size picture, pixellates every face Vision finds, and re-encodes a metadata-free JPEG plus
// a small thumbnail for the phone's own list. It runs on the global concurrent executor and
// touches neither disk nor network, so capture, import and retry can all call it freely.
//

import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
import ImageIO
import OSLog
import UniformTypeIdentifiers
import Vision

// MARK: - ImagePipeline

struct ImagePipeline: ImagePipelineProtocol {
  /// Quality of the never-uploaded thumbnail; small and good enough for a list row.
  static let thumbnailQuality: CGFloat = 0.7

  init() {}

  @concurrent
  func prepare(_ data: Data, options: PipelineOptions) async throws(PipelineError) -> PreparedPhoto {
    let started = ContinuousClock.now
    let format = ImageFormat.sniff(data)

    guard let source = Self.makeSource(data), CGImageSourceGetCount(source) > 0 else {
      throw .undecodable
    }
    let properties = Self.properties(of: source)
    let exif = ExifTimestamp.parse(exifDictionary: properties?[kCGImagePropertyExifDictionary] as? [CFString: Any])
    let declaredSize = Self.declaredPixelSize(properties)

    // ImageIO never makes a thumbnail larger than the image, so the clamp is only belt and braces
    // against upscaling when the header told us the size.
    var maxPixelSize = max(1, options.longEdge)
    if let declaredSize { maxPixelSize = min(maxPixelSize, max(declaredSize.width, declaredSize.height)) }
    guard let upright = Self.downsample(source, maxPixelSize: maxPixelSize) else { throw .undecodable }

    // Pixel size before orientation. The header always carries it for an image ImageIO decoded;
    // the fallback keeps a missing tag from failing an otherwise good photo.
    let originalSize = declaredSize ?? Self.unrotatedSize(of: upright, orientation: Self.orientation(properties))

    var image = upright
    var facesBlurred = 0
    if options.blurFaces {
      let boxes = Self.faceBoxes(in: upright)
      if !boxes.isEmpty {
        // A face we found but could not hide must never leave the phone.
        guard let hidden = Self.pixellate(image: upright, boxes: boxes) else {
          Self.log.error("face blur failed to render; dropping the photo")
          throw .encodingFailed
        }
        image = hidden
        facesBlurred = boxes.count
      }
    }

    guard let jpeg = Self.encodeJPEG(image, quality: options.jpegQuality) else { throw .encodingFailed }
    // The thumbnail is cut from the upload bytes, so it can only ever show what the upload shows.
    guard let thumbnail = Self.thumbnail(fromJPEG: jpeg, maxPixelSize: options.thumbnailLongEdge) else {
      throw .encodingFailed
    }

    let processingMs = Self.milliseconds(since: started)
    Self.log.debug("prepared \(image.width)x\(image.height) \(jpeg.count) B, \(facesBlurred) face(s), \(processingMs) ms")
    return PreparedPhoto(
      jpeg: jpeg,
      width: image.width,
      height: image.height,
      thumbnail: thumbnail,
      originalFormat: format,
      originalPixelWidth: originalSize.width,
      originalPixelHeight: originalSize.height,
      exifDate: exif?.date,
      exifOffsetSeconds: exif?.offsetSeconds,
      facesBlurred: facesBlurred,
      processingMs: processingMs
    )
  }

  private static let log = Logger(subsystem: "com.edwardkim.hackutd.shiftmemory", category: "pipeline")

  private static func milliseconds(since start: ContinuousClock.Instant) -> Int {
    let elapsed = start.duration(to: .now)
    return Int(elapsed.components.seconds) * 1000 + Int(elapsed.components.attoseconds / 1_000_000_000_000_000)
  }
}

// MARK: - Decoding

extension ImagePipeline {
  private struct PixelSize { let width: Int; let height: Int }

  /// No decoded-image cache: we only ever read the header and one downsampled rendering.
  private static func makeSource(_ data: Data) -> CGImageSource? {
    let options: [CFString: Any] = [kCGImageSourceShouldCache: false]
    return CGImageSourceCreateWithData(data as CFData, options as CFDictionary)
  }

  private static func properties(of source: CGImageSource) -> [CFString: Any]? {
    CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
  }

  private static func declaredPixelSize(_ properties: [CFString: Any]?) -> PixelSize? {
    guard let properties,
          let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
          let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
          width > 0, height > 0
    else { return nil }
    return PixelSize(width: width, height: height)
  }

  private static func orientation(_ properties: [CFString: Any]?) -> CGImagePropertyOrientation {
    let raw = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
    return CGImagePropertyOrientation(rawValue: raw) ?? .up
  }

  /// Orientations 5–8 are the rotated ones: the stored rows run along the displayed columns.
  private static func unrotatedSize(of upright: CGImage, orientation: CGImagePropertyOrientation) -> PixelSize {
    switch orientation {
    case .leftMirrored, .right, .rightMirrored, .left:
      PixelSize(width: upright.height, height: upright.width)
    default:
      PixelSize(width: upright.width, height: upright.height)
    }
  }

  /// One decode, straight to the target size, with the EXIF orientation baked into the pixels so
  /// everything downstream (Vision, Core Image, the JPEG) sees an upright image and carries no
  /// orientation tag.
  private static func downsample(_ source: CGImageSource, maxPixelSize: Int) -> CGImage? {
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceCreateThumbnailWithTransform: true,
      kCGImageSourceShouldCacheImmediately: true,
      kCGImageSourceThumbnailMaxPixelSize: max(1, maxPixelSize),
    ]
    return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
  }
}

// MARK: - Face blur

extension ImagePipeline {
  /// Face rectangles in pixel space, each grown by 30 % on every side so hair and chin go with
  /// the face, clamped to the image. Vision and Core Image both put the origin at the bottom-left
  /// corner, so the normalized box maps straight onto the image we composite over; the Y flip a
  /// UIKit or CGContext drawing path would need does not apply here.
  /// Detection trouble is not a reason to lose the photo: we log and report no faces.
  private static func faceBoxes(in image: CGImage) -> [CGRect] {
    let request = VNDetectFaceRectanglesRequest()
    let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
    do {
      try handler.perform([request])
    } catch {
      log.error("face detection failed, continuing with 0 faces: \(error.localizedDescription, privacy: .public)")
      return []
    }
    let bounds = CGRect(x: 0, y: 0, width: image.width, height: image.height)
    return (request.results ?? []).compactMap { face in
      let box = VNImageRectForNormalizedRect(face.boundingBox, image.width, image.height)
      let padded = box.insetBy(dx: -0.3 * box.width, dy: -0.3 * box.height).intersection(bounds).integral
      return padded.isEmpty ? nil : padded
    }
  }

  /// Pixellates each box into roughly six blocks across (never finer than 8 px) and composites
  /// the blocks back over the untouched image. Clamping the input first keeps blocks at the
  /// picture edge from sampling transparent nothing.
  private static func pixellate(image: CGImage, boxes: [CGRect]) -> CGImage? {
    let base = CIImage(cgImage: image)
    var composed = base
    for box in boxes {
      let filter = CIFilter.pixellate()
      filter.inputImage = base.clampedToExtent()
      filter.scale = Float(max(8, box.width / 6))
      filter.center = CGPoint(x: box.midX, y: box.midY)
      guard let blocks = filter.outputImage else { return nil }
      composed = blocks.cropped(to: box).composited(over: composed)
    }
    // Built per call: only photos with faces pay for it, and nothing here needs to be shared
    // across isolation domains.
    let context = CIContext(options: [.cacheIntermediates: false])
    return context.createCGImage(composed, from: base.extent)
  }
}

// MARK: - Encoding

extension ImagePipeline {
  /// JPEG with only a quality setting: no properties are copied, so no EXIF, GPS, maker notes or
  /// orientation leave the phone.
  private static func encodeJPEG(_ image: CGImage, quality: CGFloat) -> Data? {
    let output = NSMutableData()
    guard let destination = CGImageDestinationCreateWithData(
      output as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil
    ) else { return nil }
    let options: [CFString: Any] = [
      kCGImageDestinationLossyCompressionQuality: Double(min(max(quality, 0), 1)),
    ]
    CGImageDestinationAddImage(destination, image, options as CFDictionary)
    guard CGImageDestinationFinalize(destination), output.length > 0 else { return nil }
    return output as Data
  }

  private static func thumbnail(fromJPEG jpeg: Data, maxPixelSize: Int) -> Data? {
    guard let source = makeSource(jpeg), let small = downsample(source, maxPixelSize: maxPixelSize) else {
      return nil
    }
    return encodeJPEG(small, quality: thumbnailQuality)
  }
}

// MARK: - EXIF capture time

/// The capture time a photo carries: EXIF `DateTimeOriginal` ("yyyy:MM:dd HH:mm:ss"), refined by
/// `SubsecTimeOriginal` (the digits after the decimal point) and placed on the globe by
/// `OffsetTimeOriginal` ("+HH:MM" / "-HH:MM"). A camera that wrote no offset recorded local
/// wall-clock time, which we read in the phone's own zone and report with a nil offset so the
/// caller knows the zone was assumed.
struct ExifTimestamp: Sendable, Equatable {
  let date: Date
  /// Seconds east of UTC from `OffsetTimeOriginal`; nil when the file carried no usable offset.
  let offsetSeconds: Int?

  static func parse(exifDictionary exif: [CFString: Any]?, fallbackTimeZone: TimeZone = .current) -> ExifTimestamp? {
    guard let exif else { return nil }
    return parse(
      dateTime: exif[kCGImagePropertyExifDateTimeOriginal] as? String,
      subsec: exif[kCGImagePropertyExifSubsecTimeOriginal] as? String,
      offset: exif[kCGImagePropertyExifOffsetTimeOriginal] as? String,
      fallbackTimeZone: fallbackTimeZone
    )
  }

  static func parse(dateTime: String?, subsec: String?, offset: String?, fallbackTimeZone: TimeZone = .current) -> ExifTimestamp? {
    guard let dateTime else { return nil }
    // Tolerates the "-" and "T" some writers use; a blanked-out "    :  :     :  :  " yields no fields.
    let fields = dateTime
      .split(whereSeparator: { $0 == ":" || $0 == " " || $0 == "-" || $0 == "T" })
      .compactMap { Int($0) }
    guard fields.count == 6,
          (1...9999).contains(fields[0]), (1...12).contains(fields[1]), (1...31).contains(fields[2]),
          (0...23).contains(fields[3]), (0...59).contains(fields[4]), (0...60).contains(fields[5])
    else { return nil }

    let offsetSeconds = offset.flatMap(parseOffset)
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = offsetSeconds.flatMap { TimeZone(secondsFromGMT: $0) } ?? fallbackTimeZone
    let components = DateComponents(
      year: fields[0], month: fields[1], day: fields[2], hour: fields[3], minute: fields[4], second: fields[5]
    )
    guard let whole = calendar.date(from: components) else { return nil }
    return ExifTimestamp(date: whole + parseSubsec(subsec), offsetSeconds: offsetSeconds)
  }

  /// "+HH:MM", "-HH:MM" (also "+HHMM" and "Z"); anything else counts as no offset.
  private static func parseOffset(_ raw: String) -> Int? {
    let text = raw.trimmingCharacters(in: .whitespaces)
    if text == "Z" { return 0 }
    guard let sign = text.first, sign == "+" || sign == "-" else { return nil }
    let digits = text.dropFirst().filter { ("0"..."9").contains($0) }
    guard digits.count == 4,
          let hours = Int(digits.prefix(2)), let minutes = Int(digits.suffix(2)),
          hours <= 14, minutes <= 59
    else { return nil }
    let magnitude = hours * 3600 + minutes * 60
    return sign == "-" ? -magnitude : magnitude
  }

  /// "120" means .120 s and "5" means .5 s: the tag holds the digits after the decimal point.
  private static func parseSubsec(_ raw: String?) -> TimeInterval {
    guard let raw else { return 0 }
    let digits = raw.trimmingCharacters(in: .whitespaces).prefix { ("0"..."9").contains($0) }
    guard !digits.isEmpty, let fraction = Double("0." + digits) else { return 0 }
    return fraction
  }
}
