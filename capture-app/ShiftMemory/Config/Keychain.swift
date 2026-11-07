//
// Keychain.swift
// Shift Memory
//
// Minimal generic-password store for the ingest token (never UserDefaults, never the repo).
//

import Foundation
import Security

struct KeychainStore: Sendable {
  let service: String

  func string(for account: String) -> String? {
    var query = baseQuery(account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data else { return nil }
    return String(data: data, encoding: .utf8)
  }

  func set(_ value: String?, for account: String) {
    let query = baseQuery(account)
    guard let value, !value.isEmpty else {
      SecItemDelete(query as CFDictionary)
      return
    }
    let data = Data(value.utf8)
    let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if status == errSecItemNotFound {
      var add = query
      add[kSecValueData as String] = data
      add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
      SecItemAdd(add as CFDictionary, nil)
    }
  }

  private func baseQuery(_ account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
}
