//
// CameraRollImporter.swift
// Shift Memory
//
// Camera-roll import, the fallback path of issue #2. Photos the wearer takes with the glasses'
// shutter button while this app is not running sync through the Meta AI app into the Photos
// library. While the Settings toggle is on, this importer watches the library and hands every NEW
// photo (created after the toggle was first turned on) to the composition root, oldest first, with
// its original creation timestamp, so the upload path can send it as `source: camera_roll`. It is
// off by default and only worth turning on if issue #10 shows that shutter photos do not reach the
// app while it is backgrounded.
//
// Photos-database and image-header work runs off the main actor (`@concurrent`); only the
// observable state and the hand-off to `onPhoto` happen on the main actor. Progress lives in
// UserDefaults so nothing is imported twice across launches and Settings can show the counts.
//

import Foundation
import ImageIO
import Observation
import Photos
import os

@MainActor
@Observable
final class CameraRollImporter: NSObject, PHPhotoLibraryChangeObserver {
  // MARK: Observable state
  private(set) var authorization: ImportAuthorization
  private(set) var isEnabled = false
  private(set) var isScanning = false
  private(set) var importedCount: Int { didSet { defaults.set(importedCount, forKey: Keys.importedCount) } }
  private(set) var skippedCount: Int { didSet { defaults.set(skippedCount, forKey: Keys.skippedCount) } }
  private(set) var lastScanAt: Date? { didSet { defaults.set(lastScanAt, forKey: Keys.lastScanAt) } }
  private(set) var lastError: String?
  /// Skip library photos whose EXIF does not name the glasses (phone snapshots, screenshots).
  var onlyGlassesPhotos = true

  // MARK: Hook (set by the composition root)
  /// Called once per imported photo, oldest first, on the main actor. The receiver hands the bytes
  /// to the pipeline and upload queue; the importer only marks the photo seen once this returns.
  var onPhoto: (@Sendable (ImportedPhoto) async -> Void)?

  // MARK: Tunables
  /// The seen set keeps this many of the most recently handled asset identifiers.
  static let seenCap = 2000
  /// Upper bound per scan so a huge backlog cannot stall the app; the rest waits for the next scan.
  static let maxAssetsPerScan = 100
  /// Library change notifications arrive in bursts while the Meta AI app syncs; one scan per burst.
  static let scanDebounce: Duration = .milliseconds(1500)

  enum Keys {
    /// Only photos created after this moment are ever imported. Set once, on the first enable.
    static let since = "import.since"
    /// Asset identifiers already handled, oldest first, capped at `seenCap`.
    static let seen = "import.seen"
    static let importedCount = "import.importedCount"
    static let skippedCount = "import.skippedCount"
    static let lastScanAt = "import.lastScanAt"
  }

  // MARK: Private
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private var seenOrder: [String]
  @ObservationIgnored private var seenSet: Set<String>
  @ObservationIgnored private var isObserving = false
  @ObservationIgnored private var debounceTask: Task<Void, Never>?
  @ObservationIgnored private var rescanRequested = false
  nonisolated private static let log = Logger(
    subsystem: Bundle.main.bundleIdentifier ?? "com.edwardkim.hackutd.shiftmemory", category: "import")

  init(defaults: UserDefaults = .standard) {
    self.defaults = defaults
    authorization = Self.authorization(from: PHPhotoLibrary.authorizationStatus(for: .readWrite))
    importedCount = defaults.integer(forKey: Keys.importedCount)
    skippedCount = defaults.integer(forKey: Keys.skippedCount)
    lastScanAt = defaults.object(forKey: Keys.lastScanAt) as? Date
    let seen = defaults.stringArray(forKey: Keys.seen) ?? []
    seenOrder = seen
    seenSet = Set(seen)
    super.init()
  }

  // MARK: - Enable / disable

  /// On: ask for library access, remember the import start if this is the first enable, watch the
  /// library, and scan once right away. Off: stop watching. Denied access leaves the importer off
  /// with `lastError` telling the user where to allow it.
  func setEnabled(_ on: Bool) async {
    guard on else {
      debounceTask?.cancel()
      debounceTask = nil
      stopObserving()
      isEnabled = false
      return
    }
    lastError = nil
    // Returns the existing decision without a prompt once the user has answered.
    let status = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
    authorization = Self.authorization(from: status)
    guard Self.isUsable(authorization) else {
      isEnabled = false
      lastError = "Photo library access is off for Shift Memory. Allow it in Settings > Privacy & Security > Photos, then turn import on again."
      return
    }
    if defaults.object(forKey: Keys.since) as? Date == nil {
      defaults.set(Date(), forKey: Keys.since)
    }
    isEnabled = true
    startObserving()
    await scanNow()
  }

  // MARK: - Scanning

  /// Import every new library photo since the first enable, oldest first, at most
  /// `maxAssetsPerScan` per call. A scan requested while one is running makes it go round again.
  func scanNow() async {
    guard isEnabled, let since = defaults.object(forKey: Keys.since) as? Date else { return }
    if isScanning {
      rescanRequested = true
      return
    }
    guard onPhoto != nil else {
      // Wiring error, not a user problem: without a consumer, importing would lose the photos.
      Self.log.fault("scan skipped: onPhoto is not set")
      return
    }
    isScanning = true
    lastError = nil
    defer { isScanning = false }
    repeat {
      rescanRequested = false
      await runScan(since: since)
    } while rescanRequested && isEnabled
    lastScanAt = Date()
  }

  private func runScan(since: Date) async {
    let batch = await Self.fetchNewAssets(since: since, excluding: seenSet, limit: Self.maxAssetsPerScan)
    if batch.remaining > 0 {
      Self.log.notice("scan capped at \(Self.maxAssetsPerScan, privacy: .public) assets; about \(batch.remaining, privacy: .public) more wait for the next scan")
    }
    for candidate in batch.candidates {
      // The user may turn the toggle off mid-scan; stop without marking anything.
      guard isEnabled, let onPhoto else { return }
      switch await Self.load(candidate) {
      case .failed(let reason):
        // Not marked seen, so the next scan tries again (an iCloud copy that is offline, say).
        lastError = "Could not read a library photo: \(reason)"
        Self.log.error("load failed for \(candidate.asset.localIdentifier): \(reason, privacy: .public)")
      case .photo(let photo):
        if onlyGlassesPhotos, !photo.looksLikeGlassesPhoto {
          skippedCount += 1
          markSeen(candidate.asset.localIdentifier)
        } else {
          await onPhoto(photo)
          importedCount += 1
          markSeen(candidate.asset.localIdentifier)
        }
      }
    }
  }

  // MARK: - Library change observer

  /// Arrives on an arbitrary queue; the only work is to hop to the main actor and restart the
  /// debounce timer, so a sync burst becomes one scan.
  nonisolated func photoLibraryDidChange(_ changeInstance: PHChange) {
    Task { @MainActor in self.scheduleDebouncedScan() }
  }

  private func scheduleDebouncedScan() {
    guard isEnabled else { return }
    debounceTask?.cancel()
    debounceTask = Task { [weak self] in
      try? await Task.sleep(for: Self.scanDebounce)
      guard !Task.isCancelled, let self else { return }
      await self.scanNow()
    }
  }

  private func startObserving() {
    guard !isObserving else { return }
    PHPhotoLibrary.shared().register(self)
    isObserving = true
  }

  private func stopObserving() {
    guard isObserving else { return }
    PHPhotoLibrary.shared().unregisterChangeObserver(self)
    isObserving = false
  }

  // MARK: - Seen set

  private func markSeen(_ localIdentifier: String) {
    guard !seenSet.contains(localIdentifier) else { return }
    seenSet.insert(localIdentifier)
    seenOrder.append(localIdentifier)
    if seenOrder.count > Self.seenCap {
      seenOrder = Self.trimSeen(seenOrder, cap: Self.seenCap)
      seenSet = Set(seenOrder)
    }
    defaults.set(seenOrder, forKey: Keys.seen)
  }

  /// Keeps the `cap` most recent identifiers of a list ordered oldest first.
  nonisolated static func trimSeen(_ ids: [String], cap: Int) -> [String] {
    guard cap > 0 else { return [] }
    guard ids.count > cap else { return ids }
    return Array(ids.suffix(cap))
  }

  // MARK: - Photos work, off the main actor

  /// One library photo picked up by a scan. `PHAsset` is Sendable in the Photos SDK.
  struct Candidate: Sendable {
    let asset: PHAsset
    /// `PHAsset.creationDate`, which the fetch predicate guarantees is present.
    let creationDate: Date
  }

  private enum Loaded: Sendable {
    case photo(ImportedPhoto)
    case failed(String)
  }

  private enum Delivered: Sendable {
    case data(Data)
    case failed(String)
  }

  /// Images created after `since`, oldest first, minus the ones already handled, at most `limit`.
  /// `remaining` is roughly how many were left for the next scan.
  @concurrent
  private nonisolated static func fetchNewAssets(
    since: Date, excluding seen: Set<String>, limit: Int
  ) async -> (candidates: [Candidate], remaining: Int) {
    let options = PHFetchOptions()
    options.predicate = NSPredicate(format: "creationDate > %@", since as NSDate)
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: true)]
    let result = PHAsset.fetchAssets(with: .image, options: options)
    var candidates: [Candidate] = []
    var index = 0
    while index < result.count, candidates.count < limit {
      let asset = result.object(at: index)
      index += 1
      guard !seen.contains(asset.localIdentifier), let creationDate = asset.creationDate else { continue }
      candidates.append(Candidate(asset: asset, creationDate: creationDate))
    }
    return (candidates, result.count - index)
  }

  /// Full-size bytes plus the camera make/model from the file's TIFF tags.
  @concurrent
  private nonisolated static func load(_ candidate: Candidate) async -> Loaded {
    let options = PHImageRequestOptions()
    options.isNetworkAccessAllowed = true   // the library may hold only an iCloud copy
    options.deliveryMode = .highQualityFormat
    options.version = .current
    options.isSynchronous = false
    let delivered: Delivered = await withCheckedContinuation { continuation in
      // The handler is documented to fire once for data requests; the lock makes sure a second
      // call can never resume the continuation twice.
      let resumed = OSAllocatedUnfairLock(initialState: false)
      PHImageManager.default().requestImageDataAndOrientation(for: candidate.asset, options: options) { data, _, _, info in
        if (info?[PHImageResultIsDegradedKey] as? Bool) == true { return }
        let isFirst = resumed.withLock { done -> Bool in
          if done { return false }
          done = true
          return true
        }
        guard isFirst else { return }
        if let data {
          continuation.resume(returning: .data(data))
        } else if (info?[PHImageCancelledKey] as? Bool) == true {
          continuation.resume(returning: .failed("the request was cancelled"))
        } else {
          let reason = (info?[PHImageErrorKey] as? NSError)?.localizedDescription ?? "no image data"
          continuation.resume(returning: .failed(reason))
        }
      }
    }
    switch delivered {
    case .failed(let reason):
      return .failed(reason)
    case .data(let data):
      let camera = cameraMetadata(in: data)
      return .photo(ImportedPhoto(
        data: data,
        creationDate: candidate.creationDate,
        localIdentifier: candidate.asset.localIdentifier,
        make: camera.make,
        model: camera.model,
        pixelWidth: candidate.asset.pixelWidth,
        pixelHeight: candidate.asset.pixelHeight,
        location: candidate.asset.location.flatMap(LocationFix.init)))
    }
  }

  /// TIFF Make and Model from the image bytes (JPEG or HEIC). Reads the header only, never decodes.
  nonisolated static func cameraMetadata(in data: Data) -> (make: String?, model: String?) {
    let sourceOptions = [kCGImageSourceShouldCache: false] as CFDictionary
    guard let source = CGImageSourceCreateWithData(data as CFData, sourceOptions),
          let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any]
    else { return (nil, nil) }
    let tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any]
    return (cleaned(tiff?[kCGImagePropertyTIFFMake]), cleaned(tiff?[kCGImagePropertyTIFFModel]))
  }

  /// EXIF strings are often padded; an empty tag counts as absent.
  private nonisolated static func cleaned(_ value: Any?) -> String? {
    guard let s = (value as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !s.isEmpty else { return nil }
    return s
  }

  // MARK: - Authorization

  nonisolated static func authorization(from status: PHAuthorizationStatus) -> ImportAuthorization {
    switch status {
    case .notDetermined: .notDetermined
    case .limited: .limited
    case .authorized: .authorized
    case .denied, .restricted: .denied
    @unknown default: .denied
    }
  }

  /// Limited access counts: the user picked the photos we may read.
  nonisolated static func isUsable(_ authorization: ImportAuthorization) -> Bool {
    authorization == .authorized || authorization == .limited
  }
}
