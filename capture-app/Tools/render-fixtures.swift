// Renders two synthetic data-center panel photos (before / fault) as 1600x1200 JPEGs for the
// MockDeviceKit capture path. Text is large and high-contrast so a VLM reads it reliably.
import AppKit
import CoreGraphics

func render(path: String, fault: Bool) {
  let w = 1600, h = 1200
  let img = NSImage(size: NSSize(width: w, height: h))
  img.lockFocus()
  guard let ctx = NSGraphicsContext.current?.cgContext else { return }
  // floor + rack body
  ctx.setFillColor(CGColor(red: 0.16, green: 0.17, blue: 0.19, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
  ctx.setFillColor(CGColor(red: 0.10, green: 0.11, blue: 0.12, alpha: 1)); ctx.fill(CGRect(x: 120, y: 60, width: 1360, height: 1080))
  // vent slots
  ctx.setFillColor(CGColor(red: 0.07, green: 0.075, blue: 0.08, alpha: 1))
  for row in 0..<14 { for col in 0..<10 { ctx.fill(CGRect(x: 170 + col * 126, y: 90 + row * 44, width: 96, height: 14)) } }
  // label plates
  func plate(_ r: CGRect, fill: CGColor) { ctx.setFillColor(fill); let p = CGPath(roundedRect: r, cornerWidth: 10, cornerHeight: 10, transform: nil); ctx.addPath(p); ctx.fillPath() }
  func text(_ s: String, _ pt: CGPoint, size: CGFloat, color: NSColor, bold: Bool = true, mono: Bool = true) {
    let font = mono ? NSFont.monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular) : NSFont.systemFont(ofSize: size, weight: bold ? .bold : .regular)
    let attrs: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: color]
    NSAttributedString(string: s, attributes: attrs).draw(at: pt)
  }
  let white = NSColor.white, ink = NSColor(calibratedWhite: 0.08, alpha: 1)
  // rack id plate (top)
  plate(CGRect(x: 160, y: 1040, width: 520, height: 80), fill: CGColor(red: 0.93, green: 0.93, blue: 0.9, alpha: 1))
  text("RACK R12", CGPoint(x: 190, y: 1052), size: 54, color: ink)
  // PDU strip plate
  plate(CGRect(x: 160, y: 820, width: 1280, height: 180), fill: CGColor(red: 0.18, green: 0.20, blue: 0.24, alpha: 1))
  text("PDU-A   ROW 1", CGPoint(x: 190, y: 920), size: 54, color: white)
  text(fault ? "LOAD 11.8 kW" : "LOAD 10.9 kW", CGPoint(x: 190, y: 845), size: 50, color: NSColor(calibratedRed: 0.6, green: 0.9, blue: 1, alpha: 1))
  text("PSU1  OK", CGPoint(x: 820, y: 920), size: 50, color: NSColor(calibratedRed: 0.4, green: 0.95, blue: 0.5, alpha: 1))
  if fault {
    plate(CGRect(x: 800, y: 835, width: 600, height: 72), fill: CGColor(red: 0.75, green: 0.1, blue: 0.1, alpha: 1))
    text("PSU2  FAULT", CGPoint(x: 820, y: 845), size: 50, color: white)
  } else {
    text("PSU2  OK", CGPoint(x: 820, y: 845), size: 50, color: NSColor(calibratedRed: 0.4, green: 0.95, blue: 0.5, alpha: 1))
  }
  // switch plate
  plate(CGRect(x: 160, y: 640, width: 1280, height: 140), fill: CGColor(red: 0.22, green: 0.22, blue: 0.24, alpha: 1))
  text("SW-CORE-1   UPLINK 2/2 UP", CGPoint(x: 190, y: 680), size: 48, color: white)
  // temp readout
  plate(CGRect(x: 160, y: 470, width: 700, height: 130), fill: CGColor(red: 0.12, green: 0.14, blue: 0.16, alpha: 1))
  text(fault ? "INLET 27.4 °C" : "INLET 22.4 °C", CGPoint(x: 190, y: 505), size: 54, color: fault ? NSColor(calibratedRed: 1, green: 0.75, blue: 0.2, alpha: 1) : NSColor(calibratedRed: 0.6, green: 0.9, blue: 1, alpha: 1))
  // sticker
  plate(CGRect(x: 920, y: 470, width: 520, height: 130), fill: CGColor(red: 0.98, green: 0.80, blue: 0.1, alpha: 1))
  text("DO NOT UNPLUG", CGPoint(x: 945, y: 510), size: 46, color: ink)
  // cable tags
  text("CBL-R12-07", CGPoint(x: 190, y: 380), size: 40, color: NSColor(calibratedWhite: 0.85, alpha: 1), bold: false)
  text("CBL-R12-08", CGPoint(x: 190, y: 320), size: 40, color: NSColor(calibratedWhite: 0.85, alpha: 1), bold: false)
  img.unlockFocus()
  guard let tiff = img.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
        let jpg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.88]) else { return }
  try! jpg.write(to: URL(fileURLWithPath: path))
  print("wrote \(path) \(jpg.count) bytes")
}
render(path: "rack-panel-ok.jpg", fault: false)
render(path: "rack-panel-fault.jpg", fault: true)
