import ExpoModulesCore
import Foundation

// MARK: - Swift 6.2 strict concurrency
//
// Expo may invoke `@JS(.concurrent)` methods on a cooperative thread-pool
// executor, not on the main actor. UniFFI `MlsSession` objects are therefore
// stored in `SessionBox`, an `@unchecked Sendable` container whose dictionary
// is guarded by `NSLock` rather than isolated to `@MainActor`.
//
// Keychain access (see MlsWrappingKey.swift) is also performed on those
// concurrent executors: Security's generic-password APIs are thread-safe and
// we never hop to the main actor just to read the wrapping key.
//
// The generated UniFFI Swift (`generated/understage_mls.swift`) is compiled
// into this pod. We treat that file as foreign code and do not annotate it.
// UniFFI marks `MlsSession` `@unchecked Sendable`; we only ever touch a
// session through `SessionBox`'s lock.

/// Lock-guarded map of session ids to UniFFI `MlsSession` handles.
private final class SessionBox: @unchecked Sendable {
  private let lock = NSLock()
  private var sessions: [String: MlsSession] = [:]

  func put(_ id: String, _ session: MlsSession) {
    lock.lock()
    sessions[id] = session
    lock.unlock()
  }

  func get(_ id: String) throws -> MlsSession {
    lock.lock()
    let session = sessions[id]
    lock.unlock()
    guard let session else {
      throw Exception(
        name: "MlsSessionError",
        description: "unknown MLS session \(id)",
        code: "ERR_MLS_SESSION"
      )
    }
    return session
  }

  func remove(_ id: String) {
    lock.lock()
    sessions.removeValue(forKey: id)
    lock.unlock()
  }
}

@ExpoModule("UnderstageMls")
public class UnderstageMlsModule: Module {
  // Swift 6.2: the module instance is not MainActor-isolated. SessionBox
  // provides the synchronization that the compiler cannot see.
  private let store = SessionBox()

  @JS
  func isAvailable() -> Bool {
    true
  }

  @JS
  func ciphersuiteName() -> String {
    // Qualify with the CocoaPods module so this hits the UniFFI free
    // function in generated/understage_mls.swift rather than recursing.
    UnderstageMls.ciphersuiteName()
  }

  @JS
  func documentsDirectory() -> String {
    let url = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
    return url?.path ?? NSTemporaryDirectory()
  }

  @JS(.concurrent)
  func openSession(storagePath: String) async throws -> String {
    // Swift 6.2: hop to the MainActor for Keychain (see MlsWrappingKey.swift).
    // MlsSession.open itself is not MainActor-isolated and may run here.
    let wrappingKey = try await MlsWrappingKey.loadOrCreate()
    let session = try MlsSession.open(storagePath: storagePath, wrappingKey: wrappingKey)
    let id = UUID().uuidString
    store.put(id, session)
    return id
  }

  @JS(.concurrent)
  func closeSession(sessionId: String) async {
    store.remove(sessionId)
  }

  @JS(.concurrent)
  func generateCredential(sessionId: String, identity: String) async throws {
    try store.get(sessionId).generateCredential(identity: identity)
  }

  @JS(.concurrent)
  func exportKeyPackage(sessionId: String) async throws -> String {
    try store.get(sessionId).exportKeyPackage().base64EncodedString()
  }

  @JS(.concurrent)
  func createGroup(sessionId: String) async throws -> String {
    try store.get(sessionId).createGroup()
  }

  @JS(.concurrent)
  func addMember(sessionId: String, keyPackageB64: String) async throws -> [String: Any] {
    let result = try store.get(sessionId).addMember(keyPackage: decodeB64(keyPackageB64))
    return [
      "commit": result.commit.base64EncodedString(),
      "welcome": result.welcome.base64EncodedString(),
      "epoch": intEpoch(result.epoch),
    ]
  }

  @JS(.concurrent)
  func joinFromWelcome(sessionId: String, welcomeB64: String) async throws -> Int {
    intEpoch(try store.get(sessionId).joinFromWelcome(welcome: decodeB64(welcomeB64)))
  }

  @JS(.concurrent)
  func processIncoming(sessionId: String, messageB64: String) async throws -> [String: Any] {
    let result = try store.get(sessionId).processIncoming(message: decodeB64(messageB64))
    let plaintext: Any = result.plaintext.map { $0.base64EncodedString() } ?? NSNull()
    return [
      "kind": result.kind,
      "plaintext": plaintext,
      "epoch": intEpoch(result.epoch),
    ]
  }

  @JS(.concurrent)
  func encrypt(sessionId: String, plaintext: String) async throws -> String {
    let data = Data(plaintext.utf8)
    return try store.get(sessionId).encrypt(plaintext: data).base64EncodedString()
  }

  @JS(.concurrent)
  func decrypt(sessionId: String, ciphertextB64: String) async throws -> String {
    let bytes = try store.get(sessionId).decrypt(ciphertext: decodeB64(ciphertextB64))
    return String(data: bytes, encoding: .utf8) ?? ""
  }

  @JS(.concurrent)
  func removeMember(sessionId: String, identity: String) async throws -> [String: Any] {
    let result = try store.get(sessionId).removeMember(identity: identity)
    return [
      "commit": result.commit.base64EncodedString(),
      "epoch": intEpoch(result.epoch),
    ]
  }

  @ModuleDefinitionBuilder
  public func definition() -> ModuleDefinition {
    AsyncFunction("signaturePublicKey") { (sessionId: String) -> String in
      try self.store.get(sessionId).signaturePublicKey().base64EncodedString()
    }
  }

  @JS(.concurrent)
  func epoch(sessionId: String) async throws -> Int {
    intEpoch(try store.get(sessionId).epoch())
  }
}

private func decodeB64(_ value: String) throws -> Data {
  guard let data = Data(base64Encoded: value) else {
    throw Exception(
      name: "MlsCodecError",
      description: "invalid base64",
      code: "ERR_MLS_B64"
    )
  }
  return data
}

private func intEpoch(_ value: UInt64) -> Int {
  Int(value)
}
