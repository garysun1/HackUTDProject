#!/usr/bin/env swift
// Face blur for the weekend workspace (demo/weekend). macOS only: Apple Vision + Core Image.
//
//   swift blur.swift list <in>
//       JSON array of detected faces as normalised [x,y,w,h], origin top-left, sorted left to right.
//   swift blur.swift blur <in> <out.jpg> [--keep all|none|"x,y,w,h;x,y,w,h"] [--max 1600] [--quality 0.85]
//       Reads JPEG/HEIC/PNG honouring EXIF orientation, resizes so the long edge <= --max, detects faces,
//       blurs every face not matched by a --keep rect (IoU > 0.3 or centre inside), writes a fresh JPEG
//       with no EXIF/GPS. Face counts go to stderr. Non-zero exit with a message on failure.

import Foundation
import CoreImage
import CoreImage.CIFilterBuiltins
import Vision
import AppKit
import ImageIO
import UniformTypeIdentifiers

func warn(_ s: String) { FileHandle.standardError.write((s + "\n").data(using: .utf8)!) }
func die(_ s: String, _ code: Int32 = 1) -> Never { warn("blur.swift: " + s); exit(code) }

// MARK: - args

var args = Array(CommandLine.arguments.dropFirst())
guard let command = args.first, ["list", "blur"].contains(command) else {
    die("usage: blur.swift list <in> | blur <in> <out.jpg> [--keep all|none|\"x,y,w,h;…\"] [--max 1600] [--quality 0.85]", 2)
}
args.removeFirst()

var positional: [String] = []
var keepSpec = "none"
var maxEdge: CGFloat = 1600
var quality: CGFloat = 0.85
var i = 0
while i < args.count {
    let a = args[i]
    func value() -> String {
        i += 1
        guard i < args.count else { die("missing value for \(a)", 2) }
        return args[i]
    }
    switch a {
    case "--keep": keepSpec = value()
    case "--max":
        guard let v = Double(value()), v > 0 else { die("--max must be a positive number", 2) }
        maxEdge = CGFloat(v)
    case "--quality":
        guard let v = Double(value()), v > 0, v <= 1 else { die("--quality must be in (0,1]", 2) }
        quality = CGFloat(v)
    default:
        if a.hasPrefix("--") { die("unknown option \(a)", 2) }
        positional.append(a)
    }
    i += 1
}

guard let inPath = positional.first else { die("missing input path", 2) }
let inURL = URL(fileURLWithPath: inPath)
guard FileManager.default.fileExists(atPath: inPath) else { die("no such file: \(inPath)") }

// MARK: - keep rects (normalised, origin top-left)

enum Keep { case all, none, rects([CGRect]) }
let keep: Keep = {
    switch keepSpec.lowercased() {
    case "all": return .all
    case "none", "": return .none
    default:
        var rects: [CGRect] = []
        for part in keepSpec.split(separator: ";") {
            let nums = part.split(separator: ",").map { Double($0.trimmingCharacters(in: .whitespaces)) }
            guard nums.count == 4, !nums.contains(where: { $0 == nil }) else {
                die("bad --keep rect '\(part)' (want x,y,w,h normalised)", 2)
            }
            rects.append(CGRect(x: nums[0]!, y: nums[1]!, width: nums[2]!, height: nums[3]!))
        }
        return .rects(rects)
    }
}()

func iou(_ a: CGRect, _ b: CGRect) -> CGFloat {
    let inter = a.intersection(b)
    if inter.isNull || inter.isEmpty { return 0 }
    let ia = inter.width * inter.height
    let ua = a.width * a.height + b.width * b.height - ia
    return ua > 0 ? ia / ua : 0
}

func isKept(_ face: CGRect) -> Bool {
    switch keep {
    case .all: return true
    case .none: return false
    case .rects(let rs):
        let c = CGPoint(x: face.midX, y: face.midY)
        return rs.contains { r in iou(face, r) > 0.3 || r.contains(c) || face.contains(CGPoint(x: r.midX, y: r.midY)) }
    }
}

// MARK: - load, orient, resize

let ciContext = CIContext(options: [.cacheIntermediates: false])

guard var image = CIImage(contentsOf: inURL, options: [.applyOrientationProperty: true]) else {
    die("could not decode image: \(inPath)")
}
// Normalise origin to (0,0) after the orientation transform.
image = image.transformed(by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y))

// Detect on the full-resolution frame first: small faces at the back of a room vanish once the
// image is downscaled to 1600 px. Normalised boxes carry over to the resized image unchanged.
var fullFaces: [CGRect] = []
do {
    let fullRect = CGRect(x: 0, y: 0, width: floor(image.extent.width), height: floor(image.extent.height))
    if let fullCG = ciContext.createCGImage(image.cropped(to: fullRect), from: fullRect, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) {
        let req = VNDetectFaceRectanglesRequest()
        if let latest = VNDetectFaceRectanglesRequest.supportedRevisions.max() { req.revision = latest }
        let h = VNImageRequestHandler(cgImage: fullCG, orientation: .up, options: [:])
        if (try? h.perform([req])) != nil {
            fullFaces = (req.results ?? []).map { obs in let b = obs.boundingBox; return CGRect(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height) }
        }
    }
}
let longEdge = max(image.extent.width, image.extent.height)
if longEdge > maxEdge {
    let scale = maxEdge / longEdge
    image = image.applyingFilter("CILanczosScaleTransform", parameters: [
        kCIInputScaleKey: scale,
        kCIInputAspectRatioKey: 1.0,
    ])
    image = image.transformed(by: CGAffineTransform(translationX: -image.extent.origin.x, y: -image.extent.origin.y))
}
// Snap to integer pixels.
let pixelRect = CGRect(x: 0, y: 0, width: floor(image.extent.width), height: floor(image.extent.height))
image = image.cropped(to: pixelRect)

guard let baseCG = ciContext.createCGImage(image, from: pixelRect, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else {
    die("could not render image")
}
let W = CGFloat(baseCG.width), H = CGFloat(baseCG.height)

// MARK: - detect

let request = VNDetectFaceRectanglesRequest()
if let latest = VNDetectFaceRectanglesRequest.supportedRevisions.max() { request.revision = latest }
let handler = VNImageRequestHandler(cgImage: baseCG, orientation: .up, options: [:])
do { try handler.perform([request]) } catch { die("face detection failed: \(error.localizedDescription)") }

// Vision boxes are normalised with origin bottom-left; convert to top-left.
var faces: [CGRect] = (request.results ?? []).map { obs in
    let b = obs.boundingBox
    return CGRect(x: b.minX, y: 1 - b.maxY, width: b.width, height: b.height)
}
// union with the full-resolution pass (skip boxes that overlap one already found)
for f in fullFaces where !faces.contains(where: { $0.intersection(f).width > 0 && $0.intersection(f).height > 0 }) { faces.append(f) }
// Debug hook: BLUR_DEBUG_FACES="x,y,w,h;…" adds synthetic faces (normalised, top-left) to exercise the blur path.
if let dbg = ProcessInfo.processInfo.environment["BLUR_DEBUG_FACES"], !dbg.isEmpty {
    for part in dbg.split(separator: ";") {
        let n = part.split(separator: ",").compactMap { Double($0.trimmingCharacters(in: .whitespaces)) }
        if n.count == 4 { faces.append(CGRect(x: n[0], y: n[1], width: n[2], height: n[3])) }
    }
}
faces.sort { $0.minX < $1.minX }

func fmt(_ v: CGFloat) -> String { String(format: "%.4f", Double(v)) }
func json(_ r: CGRect) -> String { "[\(fmt(r.minX)),\(fmt(r.minY)),\(fmt(r.width)),\(fmt(r.height))]" }

if command == "list" {
    warn("blur.swift: \(faces.count) face(s) found in \(inURL.lastPathComponent) (\(Int(W))x\(Int(H)))")
    print("[" + faces.map(json).joined(separator: ",") + "]")
    exit(0)
}

// MARK: - blur

guard positional.count >= 2 else { die("blur needs <in> <out.jpg>", 2) }
let outURL = URL(fileURLWithPath: positional[1])

let toBlur = faces.filter { !isKept($0) }
var result = CIImage(cgImage: baseCG)
let fullExtent = result.extent

for face in toBlur {
    // Pixel rect, bottom-left origin (Core Image space).
    let px = CGRect(x: face.minX * W, y: (1 - face.maxY) * H, width: face.width * W, height: face.height * H)
    // Expand 35% each side.
    let ex = px.insetBy(dx: -0.35 * px.width, dy: -0.35 * px.height)
    let centre = CGPoint(x: ex.midX, y: ex.midY)

    // Strong pixelate (block ~ face height / 8) blended with a gaussian so the blocks are not razor-edged.
    let block = max(6, px.height / 8)
    let pixellated = result.clampedToExtent().applyingFilter("CIPixellate", parameters: [
        kCIInputScaleKey: block,
        kCIInputCenterKey: CIVector(x: centre.x, y: centre.y),
    ])
    let softened = pixellated.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [
        kCIInputRadiusKey: block * 0.6,
    ]).cropped(to: fullExtent)
    let plainBlur = result.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [
        kCIInputRadiusKey: block * 1.2,
    ]).cropped(to: fullExtent)
    // 65% pixelate / 35% blur.
    let obscured = softened.applyingFilter("CIDissolveTransition", parameters: [
        kCIInputTargetImageKey: plainBlur,
        kCIInputTimeKey: 0.35,
    ]).cropped(to: fullExtent)

    // Feathered elliptical mask inscribed in the expanded rect: opaque to 78% of the radius, clear at 100%.
    let unit = CIFilter.radialGradient()
    unit.center = .zero
    unit.radius0 = 0.78
    unit.radius1 = 1.0
    unit.color0 = CIColor(red: 1, green: 1, blue: 1, alpha: 1)
    unit.color1 = CIColor(red: 1, green: 1, blue: 1, alpha: 0)
    guard let grad = unit.outputImage else { die("could not build mask") }
    let t = CGAffineTransform(translationX: centre.x, y: centre.y)
        .scaledBy(x: ex.width / 2, y: ex.height / 2)
    let mask = grad.transformed(by: t).cropped(to: fullExtent)

    result = obscured.applyingFilter("CIBlendWithMask", parameters: [
        kCIInputBackgroundImageKey: result,
        kCIInputMaskImageKey: mask,
    ]).cropped(to: fullExtent)
}

guard let outCG = ciContext.createCGImage(result, from: fullExtent, format: .RGBA8, colorSpace: CGColorSpace(name: CGColorSpace.sRGB)) else {
    die("could not render output")
}

// Fresh JPEG, no EXIF/GPS carried over.
try? FileManager.default.createDirectory(at: outURL.deletingLastPathComponent(), withIntermediateDirectories: true)
guard let dest = CGImageDestinationCreateWithURL(outURL as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
    die("could not create output: \(outURL.path)")
}
CGImageDestinationAddImage(dest, outCG, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
guard CGImageDestinationFinalize(dest) else { die("could not write output: \(outURL.path)") }

warn("blur.swift: \(faces.count) face(s) found, \(toBlur.count) blurred, \(faces.count - toBlur.count) kept → \(outURL.lastPathComponent) (\(outCG.width)x\(outCG.height))")
