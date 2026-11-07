//
// CameraRollImporterTests.swift
// Shift Memory
//
// The importer's pure parts: the glasses-photo heuristic on ImportedPhoto, the seen-set trimming,
// the authorization mapping, and the camera make/model reader on JPEG bytes built here. Nothing
// touches the Photos library or the network.
//

import ImageIO
import Photos
import UniformTypeIdentifiers
import XCTest
@testable import ShiftMemory

final class CameraRollImporterTests: XCTestCase {
  // MARK: - looksLikeGlassesPhoto

  func testMetaMakeLooksLikeGlassesPhoto() {
    XCTAssertTrue(photo(make: "Meta", model: nil).looksLikeGlassesPhoto)
  }

  func testRayBanMetaModelLooksLikeGlassesPhoto() {
    XCTAssertTrue(photo(make: nil, model: "Ray-Ban Meta Wayfarer").looksLikeGlassesPhoto)
    XCTAssertTrue(photo(make: "Meta", model: "Ray-Ban Meta Wayfarer").looksLikeGlassesPhoto)
  }

  func testPhoneCameraIsNotAGlassesPhoto() {
    XCTAssertFalse(photo(make: "Apple", model: "iPhone 17").looksLikeGlassesPhoto)
  }

  func testMissingMetadataIsNotAGlassesPhoto() {
    XCTAssertFalse(photo(make: nil, model: nil).looksLikeGlassesPhoto)
  }

  // MARK: - trimSeen

  func testTrimSeenKeepsTheMostRecentIds() {
    let ids = (1...10).map { "id-\($0)" }
    XCTAssertEqual(CameraRollImporter.trimSeen(ids, cap: 3), ["id-8", "id-9", "id-10"])
  }

  func testTrimSeenLeavesShortListsAlone() {
    let ids = ["a", "b", "c"]
    XCTAssertEqual(CameraRollImporter.trimSeen(ids, cap: 3), ids)
    XCTAssertEqual(CameraRollImporter.trimSeen(ids, cap: 2000), ids)
    XCTAssertEqual(CameraRollImporter.trimSeen([], cap: 5), [])
  }

  func testTrimSeenWithNoCapacityIsEmpty() {
    XCTAssertEqual(CameraRollImporter.trimSeen(["a", "b"], cap: 0), [])
  }

  // MARK: - Authorization mapping

  func testAuthorizationMapping() {
    XCTAssertEqual(CameraRollImporter.authorization(from: .notDetermined), .notDetermined)
    XCTAssertEqual(CameraRollImporter.authorization(from: .limited), .limited)
    XCTAssertEqual(CameraRollImporter.authorization(from: .authorized), .authorized)
    XCTAssertEqual(CameraRollImporter.authorization(from: .denied), .denied)
    XCTAssertEqual(CameraRollImporter.authorization(from: .restricted), .denied)
    XCTAssertTrue(CameraRollImporter.isUsable(.limited))
    XCTAssertTrue(CameraRollImporter.isUsable(.authorized))
    XCTAssertFalse(CameraRollImporter.isUsable(.denied))
    XCTAssertFalse(CameraRollImporter.isUsable(.notDetermined))
  }

  // MARK: - cameraMetadata

  func testCameraMetadataReadsTiffMakeAndModel() throws {
    let data = try jpeg(make: "Meta", model: "Ray-Ban Meta Wayfarer")
    let camera = CameraRollImporter.cameraMetadata(in: data)
    XCTAssertEqual(camera.make, "Meta")
    XCTAssertEqual(camera.model, "Ray-Ban Meta Wayfarer")
    XCTAssertTrue(photo(make: camera.make, model: camera.model).looksLikeGlassesPhoto)
  }

  func testCameraMetadataIsAbsentOnTheRenderedFixture() throws {
    let url = try XCTUnwrap(
      Bundle.main.url(forResource: "rack-panel-ok", withExtension: "jpg")
        ?? Bundle.main.url(forResource: "rack-panel-ok", withExtension: "jpg", subdirectory: "Fixtures"))
    let camera = CameraRollImporter.cameraMetadata(in: try Data(contentsOf: url))
    XCTAssertNil(camera.make)
    XCTAssertNil(camera.model)
  }

  func testCameraMetadataOnGarbageIsAbsent() {
    let camera = CameraRollImporter.cameraMetadata(in: Data("not an image".utf8))
    XCTAssertNil(camera.make)
    XCTAssertNil(camera.model)
  }

  // MARK: - Helpers

  private func photo(make: String?, model: String?) -> ImportedPhoto {
    ImportedPhoto(
      data: Data(),
      creationDate: Date(timeIntervalSince1970: 1_800_000_000),
      localIdentifier: "test/asset",
      make: make,
      model: model,
      pixelWidth: 3024,
      pixelHeight: 4032)
  }

  /// An 8x8 JPEG whose TIFF directory names the given camera, written with ImageIO.
  private func jpeg(make: String, model: String) throws -> Data {
    let context = try XCTUnwrap(CGContext(
      data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 0,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue))
    context.setFillColor(gray: 0.5, alpha: 1)
    context.fill(CGRect(x: 0, y: 0, width: 8, height: 8))
    let image = try XCTUnwrap(context.makeImage())
    let output = NSMutableData()
    let destination = try XCTUnwrap(
      CGImageDestinationCreateWithData(output, UTType.jpeg.identifier as CFString, 1, nil))
    let properties: [CFString: Any] = [
      kCGImagePropertyTIFFDictionary: [kCGImagePropertyTIFFMake: make, kCGImagePropertyTIFFModel: model] as [CFString: Any],
    ]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    XCTAssertTrue(CGImageDestinationFinalize(destination))
    return output as Data
  }
}
