import ExpoModulesCore
import Foundation
import Security

/// 32-byte AES-256 wrapping key stored in the iOS Keychain.
///
/// Swift 6.2: Security framework keychain calls are synchronous. They are
/// isolated to the MainActor because `@JS(.concurrent)` Expo methods run on a
/// cooperative thread-pool executor. We never touch UIKit here.
///
/// On this project's unsigned Simulator builds (`CODE_SIGNING_ALLOWED=NO`)
/// `SecItemCopyMatching` can return `errSecMissingEntitlement` (-34018)
/// because the process has no `application-identifier` entitlement. When
/// that happens we fall back to a File Protection key in Application
/// Support so the module still works under the approved xcodebuild flags.
/// Signed device builds (which inject that entitlement) use the Keychain.
@MainActor
enum MlsWrappingKey {
  static let service = "com.understage.app.mls"
  static let account = "wrapping-key-v1"
  private static let missingEntitlement: OSStatus = -34018

  static func loadOrCreate() throws -> Data {
    do {
      return try loadOrCreateKeychain()
    } catch {
      let text = String(describing: error)
      if text.contains("-34018") || text.contains("\(Self.missingEntitlement)") {
        return try loadOrCreateFileFallback()
      }
      throw error
    }
  }

  private static func loadOrCreateKeychain() throws -> Data {
    let encodedAccount = Data(account.utf8)
    var query = baseQuery(encodedAccount: encodedAccount)
    query[kSecReturnData as String] = kCFBooleanTrue
    query[kSecMatchLimit as String] = kSecMatchLimitOne

    var item: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &item)
    if status == errSecSuccess, let data = item as? Data, data.count == 32 {
      return data
    }
    if status == missingEntitlement {
      throw keychainError("Keychain read failed with status \(status)")
    }
    if status != errSecSuccess && status != errSecItemNotFound {
      throw keychainError("Keychain read failed with status \(status)")
    }

    let data = try randomKey()

    var add = baseQuery(encodedAccount: encodedAccount)
    add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    add[kSecValueData as String] = data
    let addStatus = SecItemAdd(add as CFDictionary, nil)
    if addStatus == missingEntitlement {
      throw keychainError("Keychain write failed with status \(addStatus)")
    }
    if addStatus == errSecDuplicateItem {
      item = nil
      var retry = baseQuery(encodedAccount: encodedAccount)
      retry[kSecReturnData as String] = kCFBooleanTrue
      retry[kSecMatchLimit as String] = kSecMatchLimitOne
      let retryStatus = SecItemCopyMatching(retry as CFDictionary, &item)
      if retryStatus == errSecSuccess, let existing = item as? Data, existing.count == 32 {
        return existing
      }
      throw keychainError("Keychain read failed with status \(retryStatus)")
    }
    guard addStatus == errSecSuccess else {
      throw keychainError("Keychain write failed with status \(addStatus)")
    }
    return data
  }

  private static func baseQuery(encodedAccount: Data) -> [String: Any] {
    // Same shape as expo-secure-store: service + account + generic, no
    // kSecUseDataProtectionKeychain (that flag can itself yield -34018
    // on the unsigned Simulator).
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: encodedAccount,
      kSecAttrGeneric as String: encodedAccount
    ]
  }

  private static func loadOrCreateFileFallback() throws -> Data {
    let url = try fallbackURL()
    if let existing = try? Data(contentsOf: url), existing.count == 32 {
      return existing
    }
    let data = try randomKey()
    try data.write(
      to: url,
      options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication]
    )
    return data
  }

  private static func fallbackURL() throws -> URL {
    guard let root = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first else {
      throw keychainError("Application Support directory is unavailable")
    }
    let dir = root.appendingPathComponent("understage-mls", isDirectory: true)
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    return dir.appendingPathComponent(account)
  }

  private static func randomKey() throws -> Data {
    var bytes = [UInt8](repeating: 0, count: 32)
    let rngStatus = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
    guard rngStatus == errSecSuccess else {
      throw keychainError("SecRandomCopyBytes failed with status \(rngStatus)")
    }
    return Data(bytes)
  }

  private static func keychainError(_ description: String) -> Exception {
    Exception(
      name: "MlsKeychainError",
      description: description,
      code: "ERR_MLS_KEYCHAIN"
    )
  }
}
