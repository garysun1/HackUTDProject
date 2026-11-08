// Prints capture time and GPS for image files: swift exif.swift <files...>  → TSV file \t date \t lat \t lon \t alt
import Foundation
import ImageIO
for path in CommandLine.arguments.dropFirst() {
  let url = URL(fileURLWithPath: path)
  guard let src = CGImageSourceCreateWithURL(url as CFURL, nil), let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [String: Any] else { print("\(path)\t\t\t\t"); continue }
  let exif = props[kCGImagePropertyExifDictionary as String] as? [String: Any]
  let gps = props[kCGImagePropertyGPSDictionary as String] as? [String: Any]
  let date = (exif?[kCGImagePropertyExifDateTimeOriginal as String] as? String) ?? ""
  let off = (exif?["OffsetTimeOriginal"] as? String) ?? ""
  var lat = "", lon = "", alt = ""
  if let g = gps, let la = g[kCGImagePropertyGPSLatitude as String] as? Double, let lo = g[kCGImagePropertyGPSLongitude as String] as? Double {
    let ns = (g[kCGImagePropertyGPSLatitudeRef as String] as? String) == "S" ? -1.0 : 1.0
    let ew = (g[kCGImagePropertyGPSLongitudeRef as String] as? String) == "W" ? -1.0 : 1.0
    lat = String(la * ns); lon = String(lo * ew)
    if let a = g[kCGImagePropertyGPSAltitude as String] as? Double { alt = String(a) }
  }
  let w = props[kCGImagePropertyPixelWidth as String] ?? 0, h = props[kCGImagePropertyPixelHeight as String] ?? 0
  print("\(url.lastPathComponent)\t\(date) \(off)\t\(lat)\t\(lon)\t\(alt)\t\(w)x\(h)")
}
