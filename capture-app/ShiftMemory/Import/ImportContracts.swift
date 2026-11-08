//
// ImportContracts.swift
// Shift Memory
//
// Camera-roll import (issue #2): photos the wearer took while this app was not running sync via
// the Meta AI app into the Photos library; the importer uploads new ones with their original
// creation timestamps as `source: camera_roll`.
//

import Foundation

struct ImportedPhoto: Sendable {
  /// Full-size image bytes as stored in the library (JPEG or HEIC).
  let data: Data
  /// `PHAsset.creationDate`: the capture time, not the import time.
  let creationDate: Date
  let localIdentifier: String
  /// EXIF Make / Model when the asset carries them (Ray-Ban Meta photos name Meta).
  let make: String?
  let model: String?
  let pixelWidth: Int
  let pixelHeight: Int
  /// `PHAsset.location` when the library has one (where the photo was taken), else nil.
  var location: LocationFix? = nil

  /// True when the metadata names the glasses. Used by the "only glasses photos" filter.
  var looksLikeGlassesPhoto: Bool {
    let s = ((make ?? "") + " " + (model ?? "")).lowercased()
    return s.contains("meta") || s.contains("ray-ban") || s.contains("rayban") || s.contains("oakley")
  }
}

enum ImportAuthorization: String, Codable, Sendable {
  case notDetermined, denied, limited, authorized
}
