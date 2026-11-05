# Understage E2EE: OpenMLS (RFC 9420) plan

**Status:** implementation plan. Phase 0 completed 5 November 2026 (see §16). Product app and server code were not changed in Phase 0.  
**Date:** 5 November 2026  
**Decision:** group encryption will use MLS via OpenMLS (MIT), not libsignal sender keys and not a custom TweetNaCl ratchet. This note is the implementation plan for that choice: ciphersuite, whether MLS also covers 1:1 chats, the Node server’s Authentication Service and Delivery Service roles, on-device storage, credentials and safety numbers, cost at 200 members, attachments and calls, announcements, migration from `nacl.box`, the native module and Intel-Mac toolchain, phases with verifiable milestones, risks, and the UI claims that may be made after each phase.

The earlier note `docs/E2EE_SENDER_KEYS_MIGRATION.md` remains useful as a record of why libsignal was considered and why its AGPL / App Store extra-permission problem blocked it. This document supersedes it as the plan of record for implementation.

---

## 1. Why OpenMLS, and what it is today

OpenMLS is a Rust implementation of Messaging Layer Security, RFC 9420. It is MIT-licensed (changed from GPL in 2020), maintained by Phoenix R&D and Cryspen, and used in production messengers including Wire, XMTP, Cloudflare Meet, and others.

**Current crate (checked 5 November 2026):** `openmls` **0.9.2**, published 22 October 2026 on crates.io. Companion crates published with the 0.9 line include `openmls_sqlite_storage` **0.3.0** (25 August 2026, rusqlite-based `StorageProvider`) and `openmls_traits` 0.6.x. MSRV for 0.9 is **Rust 1.91**. Pin `openmls` 0.9.2 (or a later 0.9.x patch) together with the matching `openmls_sqlite_storage` / `openmls_rust_crypto` / `openmls_basic_credential` versions; do not mix a 0.8 storage crate with 0.9 protocol code.

**Maturity:**

- Feature-complete for RFC 9420 with two small exceptions noted by the maintainers. Validation of MLS messages is type-driven and includes the checks the RFC requires.
- Independent security audit by SRLabs, sponsored by the Sovereign Tech Agency, reported 27 May 2026: eight findings, one High. Fixes for seven shipped in `openmls` **0.8.1** and **0.7.3** (the audit write-up referred to those as “8.1 and 7.3”). 0.9.2 is well after that remediation. The remaining Low issue was still being addressed at the time of the write-up; treat “we use an audited library” as true of OpenMLS itself, not as an audit of Understage’s integration.
- Interoperability has been tested against MLS++, `mls-rs`, BouncyCastle, and `ts-mls`.
- CI **builds and tests** `x86_64-unknown-linux-gnu`, `x86_64-pc-windows-msvc`, `aarch64-apple-darwin`, and `aarch64-unknown-linux-gnu`.
- CI **builds but does not test** `aarch64-apple-ios` (among others). It does **not** list `x86_64-apple-ios`. That target is required for the Intel Mac Simulator and is therefore a Phase 1 spike item, not an assumption.
- Post-quantum ciphersuites exist as draft work behind feature flags in 0.9 (`targeted-messages-draft`, `extensions-draft`, ML-KEM / ML-DSA suites). They are not the production ciphersuite for this plan.

**License:** MIT. Compatible with a closed-source App Store app. No AGPL conversation, and no paid OpenMLS license, is required to ship the library. Attribution in a NOTICE file is still good practice.

MLS is a group protocol with tree-based key updates: adding or removing a member (or a self-Update for post-compromise security) costs O(log n) in the number of members, and application messages are a single ciphertext for the whole group. That is why it was chosen for the video’s 200-person Company workspace, instead of per-recipient `nacl.box` (capped at 50) or sender keys (one ciphertext per send, but O(n²) to evict a member).

---

## 2. Ciphersuite

OpenMLS 0.9.2 documents three production ciphersuites:

| Ciphersuite | Role | KEM / AEAD / hash / signature |
|---|---|---|
| `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519` | RFC 9420 **MTI** (mandatory to implement) | X25519-HPKE, AES-128-GCM, SHA-256, Ed25519 |
| `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519` | Optional | X25519-HPKE, ChaCha20-Poly1305, SHA-256, Ed25519 |
| `MLS_128_DHKEMP256_AES128GCM_SHA256_P256` | Optional | P-256-HPKE, AES-128-GCM, SHA-256, P-256 |

**Required ciphersuite for Understage: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`.**

Reasons:

1. It is the RFC’s mandatory suite, so it is the most widely implemented and the one OpenMLS and other stacks test first.
2. AES-128-GCM is hardware-accelerated on iPhone and on this Intel Mac, so it is a good default for 200-member commits as well as ordinary messages.
3. HPKE uses X25519, which is the same curve family as today’s TweetNaCl identity keys (those keys are still not reusable as MLS init keys; see §10).
4. Signatures are Ed25519, which is the natural public key to bind into a Basic credential and a safety number.
5. One suite only. Advertising both X25519 suites would double KeyPackage uploads and split groups. Do not also enable the P-256 suite just to gesture at the Secure Enclave: Apple’s SE generates P-256 keys, but wiring OpenMLS signers to the SE is a separate project, the HPKE leaf keys would still be software keys, and the UI still must not say “your identity key lives in the Secure Enclave” unless that extra work is real (see §14).

**Not now:** draft PQ suites (ML-KEM / ML-DSA) behind 0.9 feature flags. Revisit once the MLS PQ ciphersuites draft is stable and OpenMLS marks those suites as supported without a draft flag. Until then, do not claim post-quantum MLS.

The ChaCha20-Poly1305 X25519 suite is a reserved alternative if a Phase 1 measurement shows a problem with AES-GCM on a target device. It is not required for Simulator development.

---

## 3. Does MLS replace 1:1 encryption?

Three options exist:

| Option | Meaning | Verdict |
|---|---|---|
| A. MLS for groups only; 1:1 stays TweetNaCl `nacl.box` | Two stacks forever. 1:1 keeps no forward secrecy and no PCS. Call signalling stays on static identity keys. | Reject as the end state. Accept only as the dual-stack *transition*. |
| B. MLS for groups; a second pairwise protocol for 1:1 (Double Ratchet / Olm / libsignal) | Strong 1:1, but two native cryptographic stacks, two identities, two safety-number stories. libsignal was already declined on licensing grounds. | Reject. The point of choosing OpenMLS was one MIT-licensed protocol library. |
| C. MLS for everything: a 1:1 chat is a 2-member MLS group | One module, one credential, one safety number, one server DS, one migration. RFC 9420 allows groups of two. Application messages in a stable pair do not need a Commit. | **Recommend.** |

**Recommendation: option C.** Once both participants have uploaded KeyPackages, a direct conversation is created as an MLS group of two (Alice creates a group and commits an Add of Bob’s KeyPackage; Bob joins from the Welcome). Later 1:1 application messages are ordinary MLS `PrivateMessage`s at the current epoch. Membership of a 1:1 conversation does not change in Understage (adding a third person is a *new* group conversation, as the product already models it), so the pair almost never pays the Commit cost after the initial Welcome.

Call signalling for a 1:1 call uses that same 2-member group (see §9). Attachments and voice notes use the same application-message plaintext as group chats (see §9).

Until a conversation’s members are all MLS-capable, the existing `nacl.box` fan-out remains in use (dual stack, §10). After cutover, TweetNaCl stays only as a historical decrypt path for v1 ciphertext.

Creating a 1:1 therefore requires the peer to have at least one unused KeyPackage (or a last-resort KeyPackage) on the server, exactly as starting an MLS group does. If none exist, the client waits, asks them to open the app (which replenishes KeyPackages), or — during dual-stack only — falls back to v1 `nacl.box`.

---

## 4. Authentication Service and Delivery Service on the Node server

RFC 9750 splits infrastructure into an **Authentication Service** (who is this credential?) and a **Delivery Service** (move MLS messages around, and hand out KeyPackages). Understage’s existing Node/TypeScript server, SQLite, JWT sessions, and Socket.IO already sit in the right place to play both roles. The server still never sees application plaintext, epoch secrets, or signature private keys.

### 4.1 Authentication Service

- A user’s MLS **Basic credential** identity is their Understage `user.id` (stable server-assigned id, not `@username`, which can change).
- On upload, the server verifies:
  - the caller is authenticated;
  - the KeyPackage (and any separately published credential) decodes;
  - the credential identity bytes equal `req.userId`;
  - the KeyPackage lifetime is acceptable (reject a lifetime longer than OpenMLS’s default of about three months);
  - the ciphersuite is the required suite in §2.
- OpenMLS on the *client that consumes* a KeyPackage also verifies the MLS signature. The app must additionally check that `credential.identity` equals the Understage user they intended to add. Do not trust the DS’s filename or query string alone.
- The user’s Ed25519 **signature public key** is stored and returned on `GET /users/:id` and on conversation member lists, so safety numbers work before a shared group exists.
- There is no certificate authority and no X.509. Basic credentials plus the binding above are enough for a closed user directory.

### 4.2 KeyPackage directory (DS)

KeyPackages let someone be added while they are offline. OpenMLS’s book describes the flow: generate bundles locally (private init and encryption keys stay in the on-device store), upload only the public `KeyPackage`, the DS issues each non-last-resort package at most once, and the adder builds a Commit + Welcome from it.

Default lifetime in OpenMLS is **3 × 28 days** (about three months), with `not_before` shifted one hour into the past for clock skew. Clients upload several ordinary packages plus one last-resort package (`KeyPackage::builder().mark_as_last_resort()`). Last-resort packages may be reused when the pool is empty; RFC 9750 says to minimise that, and to rotate a last-resort package after it is used. Consuming an ordinary KeyPackage on the joining client deletes the matching private init key from the StorageProvider, except for last-resort packages.

**Endpoints (conceptual):**

- `POST /me/key-packages` — body: one or more `{ ciphertext: <tls-serialized KeyPackage, base64>, hashRef, lastResort, notBefore, notAfter }`. Server stores opaque bytes, keyed by `hashRef`, owned by `req.userId`. Reject expired or wrong-identity packages.
- `GET /me/key-packages/status` — counts of remaining ordinary and last-resort packages that have not expired.
- `GET /users/:id/key-package` — **atomically** select one unused, unexpired, ordinary KeyPackage for that user, mark it consumed (delete the row), and return it. If none remain, return the last-resort package without deleting it, and record that it was used so the owner can rotate. Two concurrent fetchers must not receive the same ordinary package (SQLite `DELETE … RETURNING` inside a transaction, or equivalent).
- `PUT /me/mls/credential` — publish `{ signaturePublicKey, credentialIdentity }` for safety numbers and AS checks. Can be folded into an extended `PUT /me/keys` during dual-stack so the old `{ identityKey }` TweetNaCl upload still works.

Rate-limit `GET /users/:id/key-package`. Replenish from the client when ordinary packages drop below a watermark (for example 5 remaining; upload a batch of 20 plus a fresh last-resort if the previous one was used).

### 4.3 Group delivery, epochs, and commit ordering

Map each Understage `conversation.id` to an MLS `GroupId` (the conversation UUID as bytes is fine). Persist:

- `mls_groups(conversation_id, group_id, epoch)` — current epoch, initially unset until the creator’s first Commit/Welcome lands.
- `mls_messages(id, conversation_id, sender_id, epoch, kind, body, created_at)` — `kind` is `commit`, `proposal`, `welcome`, or `application`.
- Welcomes are **not** fan-out messages. Store `mls_welcomes(conversation_id, recipient_id, epoch, body, commit_id)` and deliver only to the added member(s).

Rules the DS must enforce (these are what keep every member on the same ratchet tree):

1. **Single writer per group.** Accept a Commit in a SQLite transaction that reads `mls_groups.epoch`. The Commit was produced at epoch `E` and advances the group to `E+1`. Accept it only if the stored epoch is `E` (or the group has no epoch yet and this is the creating Commit). Then write the Commit, set epoch to `E+1`, and store any accompanying Welcomes.
2. **Concurrent commits.** A second Commit that still claims epoch `E` after the first has been accepted is rejected with `409 EPOCH_CONFLICT`, including the winning Commit (or a pointer to `GET /conversations/:id/mls?after_epoch=`). The losing client processes the winning Commit, reapplies its intent (add, remove, or self-Update) as a new Commit at the new epoch, and resubmits. Do not “merge on the server”: the server cannot read or combine Commits.
3. **Never deliver a Welcome before its Commit is accepted.** OpenMLS’s own manual warns that doing so produces an invalid group on the joiner. Persist Welcome rows in the same transaction as the Commit, then push.
4. **Fan-out after accept.** Existing members receive the Commit (Socket.IO `mls:commit` plus the sync cursor). Added members receive their Welcome (`mls:welcome`). Application messages are stored once and delivered to current members; include `epoch` so a client that sees a gap knows to fetch missed Commits first.
5. **Do not use fork-resolution as the happy path.** OpenMLS 0.9 has an optional `fork-resolution` feature. The DS should prevent forks by serialising Commits. Fork recovery is a last resort if a bug or a partition creates one, not a substitute for §4.3.1.
6. **Persist Commits for the life of the conversation** (until the workspace is wrapped and purged). A member who was offline for several epochs must replay every missed Commit in order. Application messages can keep the existing retention; handshake messages are small and must not be dropped while anyone might still need them.
7. Prefer **atomic add/remove** (`MlsGroup::add_members` / `remove_members`, which build the proposal and the Commit together) over a standalone Proposal queue. That removes a class of “proposal landed, commit lost” races. Two admins who add different people at the same moment still collide at the epoch lock and retry, which is correct.

`GET /conversations/:id/mls?after_epoch=&after_id=` returns the ordered handshake (and, if requested, application) messages needed to catch up. The existing `/sync` cursor can grow a parallel MLS cursor rather than overloading v1 message payloads.

Application messages no longer require one payload per member. The v2 path stores a single ciphertext. Receipts, push, quiet-hours holding of *notifications*, and unread counts stay per user, as they do today.

---

## 5. On-device MLS state

All OpenMLS mutation happens in Rust. JavaScript receives and sends opaque TLS-serialized bytes (base64) and never sees signature secrets, HPKE secrets, epoch secrets, or StorageProvider pickles.

OpenMLS persists through the `StorageProvider` trait: group state, proposals, signature and encryption key pairs, epoch key pairs, KeyPackage private parts, and PSKs. Use the official **`openmls_sqlite_storage`** crate (0.3.0 for the 0.9 line), not an ad-hoc JSON blob in AsyncStorage.

Layout:

- A dedicated SQLite file in the app sandbox, for example `Library/Application Support/mls/<userId>.sqlite`, mode `0600`, **not** the existing message-cache database.
- A 256-bit **database wrapping key** in the iOS Keychain, accessibility `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (the same class already used for the TweetNaCl identity). Prefer SQLCipher or an equivalent page-level encryption of this file keyed by that secret. If SQLCipher cannot be linked without extra system packages in Phase 1, ship file protection plus the wrapping key and add SQLCipher in Phase 2 before any real users hold MLS secrets; do not leave epoch secrets in an unencrypted sqlite file.
- The Ed25519 **signature private key** is the long-term identity. Store it in the Keychain as its own item (not only inside the sqlite file) so a wrapping-key rotation can re-seal the database without inventing a new safety number. OpenMLS also keeps a copy in the StorageProvider; both views must stay in sync, and the Keychain remains the recovery copy on that phone.
- Do not back the MLS database up to iCloud. Restoring an older file is a rollback of spent epoch state (reuse-guard reuse). Encryption at rest does not provide freshness; iOS does not expose a monotonic hardware counter to apps for this. A new phone already means a new credential under the single-device rule.
- **One writer.** Every native call that reads-modifies-writes group state runs under a per-database lock. Overlapping encrypt/decrypt/commit on the same snapshot can drop an epoch advance and desynchronise the group. This is a known class of bug in MLS wrappers.
- Configure `max_past_epochs` (and 0.9’s time-based past-epoch secret deletion) so a slightly delayed message still decrypts, then delete old epoch secrets to preserve forward secrecy.

The existing `expo-secure-store` session and legacy identity keys stay as they are. The MLS store is additive.

---

## 6. Credentials and safety numbers

- Credential type: **Basic credential**, identity = Understage `user.id`.
- Signer: Ed25519 `SignatureKeyPair` from the required ciphersuite (`openmls_basic_credential::SignatureKeyPair`).
- `CredentialWithKey` ties that credential to the signature public key and is what `KeyPackage::builder().build(...)` and group creation take.

Safety numbers (replace the current TweetNaCl iterated hash once both sides have MLS credentials):

- Inputs: the two users’ ids and Ed25519 signature public keys, sorted so both phones compute the same value.
- Hash with SHA-256 (or a labelled HKDF) and display as the same 60-digit / 12-group UX and QR the app already has.
- Verifying still means comparing that number or scanning the QR, then `POST`ing the existing verified-contact flag.
- Publishing a new signature key (new phone, or `propose_self_update_with_new_signer`) changes the safety number and clears other people’s `verified` flags, the same way `PUT /me/keys` already clears verification when the TweetNaCl identity changes.

Do not call this a “Signal safety number”. It is an Understage number bound to MLS Basic credentials.

Username, display name, and avatar are not part of the credential. A renamed `@username` must not rotate keys or break verification.

---

## 7. Add / remove cost at 200 members

MLS’s ratchet tree makes membership changes logarithmic. For a group of 200, tree depth is about 8 (the tree is padded to a power of two).

| Operation | What happens | Order of cost at n = 200 |
|---|---|---|
| Application message (text, once the group exists) | One `PrivateMessage` stored and fanned out | O(1) ciphertext, same as sender keys after setup |
| Add one member | Fetch one KeyPackage; `add_members`; fan out one Commit; deliver one Welcome | O(log n) UpdatePath in the Commit; one Welcome. A few kilobytes, not 199 pairwise SKDMs |
| Add many members in one go | `add_members` accepts a slice of KeyPackages | One Commit covering all added leaves; one Welcome that can cover everyone added in that Commit. This is the right way to found a 200-person workspace chat |
| Remove one member | `remove_members`; fan out one Commit; no Welcome | O(log n). The removed leaf is blanked; they cannot decrypt later epochs |
| Self-Update (PCS) | Periodic `propose_self_update` / commit so a stolen leaf key heals | O(log n) per updating member, stagger these |
| Concurrent add/remove by two admins | Second Commit gets `EPOCH_CONFLICT`, processes the first, retries | One extra round trip, not a fork |

Compared with the rejected sender-keys plan: evicting someone there required up to `200 × 199` pairwise distributions. Here it is one Commit. That is the operational reason OpenMLS was chosen for Company workspaces.

Founding a 200-person group should be **batched Adds** (as many KeyPackages as the commit size comfortably holds; if needed, a short sequence of Commits each adding a batch), not 199 separate create-and-retry loops in the UI. Measure actual Commit size and time in Phase 5 rather than promising a number here.

Every member should self-Update on a schedule (for example every 7 days, or after a last-resort KeyPackage was used to join) so post-compromise security is not only recovered when someone happens to be added or removed.

---

## 8. Announcements stay plaintext

Workspace announcements remain readable on the server. Acknowledgement tracking, Remind, department targeting, and quiet-hours holding all need the server to see title and body. The compose screen already says they are not end-to-end encrypted. This plan does not change that, and UI copy must keep saying it.

Notification *metadata* (“you have 3 held items”) can stay as it is. Held chat notifications already do not include message plaintext.

---

## 9. Attachments, voice notes, and calls

**Files and voice notes.** Keep the two-layer design:

1. Encrypt file bytes with a fresh content key (during dual-stack this may remain `nacl.secretbox`; after cutover prefer AES-256-GCM, which matches the ciphersuite family better than XSalsa20).
2. Put `{ id, key, nonce, mime, name, size, … }` in the MLS application plaintext (the same `PlainMessage` shapes as today).
3. Encrypt that plaintext with MLS (2-member or multi-member group).
4. Upload only the opaque blob to `POST /attachments`.

A 200-person voice note is then one encrypted blob plus one MLS application message, not one blob plus 200 boxes of the file key. The 25 MB client limit can stay.

**Calls.** Media remains WebRTC DTLS-SRTP (STUN today; TURN is still a separate infrastructure blocker). Signalling (SDP and ICE) should be sent as MLS application messages — or a distinguished content type inside them — on the 2-member MLS group for that 1:1, not as `nacl.box` of the static TweetNaCl identity. That gives signalling forward secrecy once the pair has an MLS epoch, and it stops the server substituting DTLS fingerprints if the group epoch is authentic.

Group calls are not in the video and stay out of scope. CallKit, PushKit, and TURN remain independent production blockers. This plan does not mark calling “tested” until two endpoints have actually connected.

---

## 10. Migration from TweetNaCl

There is no cryptographic conversion of a historical `nacl.box` into an MLS `PrivateMessage`. Plan for coexistence, then a cutover.

**Stay readable locally.** Plaintext already in the device message cache remains. Keep the legacy TweetNaCl identity in the Keychain under a distinct item (`legacy_identity_${userId}`) after the MLS credential is created, so v1 ciphertexts still on the server can be decrypted on sync. Deleting that secret makes server-held v1 history unreadable on that phone.

**Dual stack.**

- v1: today’s `{ payloads: [{ recipientId, nonce, ciphertext }] }`, one box per member, 50-member cap unchanged.
- v2: `{ envelopeVersion: 2, protocol: "mls", kind: "application" | "commit" | "welcome" | "proposal", epoch, ciphertext }`. Application messages store **one** ciphertext. Handshake messages follow §4.3.

A conversation becomes v2-capable when every current member has an MLS credential and at least one KeyPackage (or last-resort) available — or, for members already in the group, a Welcome has been processed so they share epoch state. Until then, senders use v1.

Once every member is in the MLS group at a common epoch, new messages from updated clients are v2 application messages. Old v1 rows remain decryptable with the legacy identity.

Clients must not run v2 bytes through `nacl.box.open` or v1 bytes through OpenMLS.

**Test and seed data** (Hamlet demo crew, smoke users, `server/scripts/*` messages) should be **reset**, not converted. Build the 200-person development workspace only after v2 exists, in an isolated development workspace, not in a personal account.

**New phone.** As today: new MLS credential, new safety number, no history transfer. Single device only (no multi-device MLS, no Secure Value Recovery) in this project.

---

## 11. Native module and Intel Mac build

Hermes cannot run OpenMLS. Cryptographic state stays in Rust and is exposed through a first-party Expo module, for example `modules/understage-mls`.

**Stack:**

- Rust crate wrapping `openmls` 0.9.2, `openmls_rust_crypto` (no system OpenSSL), `openmls_basic_credential`, `openmls_sqlite_storage`.
- UniFFI generates the Swift API (`encrypt`, `decrypt`, `createGroup`, `addMembers`, `removeMembers`, `processWelcome`, `processCommit`, `createKeyPackages`, `safetyNumber`, …) over opaque byte arrays.
- An Expo module (Swift) calls that API and is autolinked like the app’s other native modules. JavaScript in `engine.ts` swaps `encryptForRecipients` / `decryptPayload` for these calls on the v2 path.
- Prefer UniFFI as a build-time dependency (`uniffi-bindgen` invoked from `build.rs` or a Makefile) rather than a globally installed CLI, so a clean machine only needs rustup and Xcode.

**Targets on this Mac (Intel, Xcode 26.3, Swift 6.2, iOS Simulator 26.3):**

- `x86_64-apple-ios` — iPhone Simulator on this machine (required).
- `aarch64-apple-ios` — physical iPhone (required before a device install).
- `aarch64-apple-ios-sim` — Apple Silicon Simulator only; **not** required here and must not replace the x86_64 slice.

Produce an XCFramework that at least contains the Intel Simulator slice for day-to-day work, then add the device slice when linking a cable. `EXPO_USE_PRECOMPILED_MODULES=0` stays set. The existing `patch-package` Swift 6.2 fix for `expo-modules-jsi` stays. Expo SDK **58** and React Native **0.88.1** do not change. No EAS, no cloud compile.

UniFFI-generated Swift may need Sendability adjustments under Swift 6.2; fix those in the wrapper, not by downgrading Xcode.

### 11.1 Tooling on the owner’s Mac, and sudo

Install rustup **in the home directory**, not with sudo:

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --no-modify-path
# then prepend $HOME/.cargo/bin to PATH in the shell that builds
```

That creates `$HOME/.rustup` and `$HOME/.cargo`. No root, no Homebrew formula for Rust.

Exact tools:

| Tool | Purpose | Already present? | sudo? |
|---|---|---|---|
| Xcode 26.3 with the iOS 26.2/26.3 platform and Simulator runtime | Compile Swift, link the Expo module, run the iPhone 17 Pro Simulator | Yes, from the successful native build | No further install if it stays as it is |
| Xcode command-line tools (`xcrun`, `clang`, `sdkPath`) | Rust `cc` crate finds the iOS SDK through `xcrun` | Yes, or the app would not have built | No. `xcode-select --install` only if `xcrun` is missing; that GUI may ask for an admin password, but it should not be needed now |
| rustup + rustc + cargo, **stable ≥ 1.91** (OpenMLS 0.9 MSRV) | Compile OpenMLS | Not required until Phase 1 | **No** (home-directory install above) |
| `rustup target add x86_64-apple-ios` | Intel Simulator | After rustup | **No** |
| `rustup target add aarch64-apple-ios` | Physical iPhone | After rustup | **No** |
| Optional: `rustup target add aarch64-apple-ios-sim` | Future Apple Silicon Simulator | Skip on this Mac | **No** |
| Node 22 and the existing local CocoaPods / gem PATH used to build Understage | Metro, `pod install` if the module adds a pod | Yes | **No** |
| iOS system `libsqlite3` (used via rusqlite) or rusqlite’s `bundled` feature | OpenMLS sqlite provider | SDK already provides sqlite; prefer `bundled` to avoid extra packages | **No** |

**Nothing in this plan requires sudo** if Xcode 26.3 and its command-line tools remain in place. Do not install Rust via Homebrew, do not `sudo cargo`, and do not install system SQLite or OpenSSL packages. `openmls_rust_crypto` uses RustCrypto. Prefer rusqlite `bundled` so the crate compiles sqlite from source with clang.

A native rebuild **is** required once the module is linked. It cannot be hot-patched onto the current `Understage.app` with Metro alone. It should not require discarding the successful Xcode project or repeating `npm ci` without cause.

---

## 12. Phases and verifiable milestones

Estimates assume one engineer in this repo, native builds on the owner’s Intel Mac, no Cloud Agent, no EAS, no SDK downgrade.

### Phase 0 — Toolchain (about a day)

- Install rustup in `$HOME` (no sudo) and verify `rustc --version` is ≥ 1.91.
- `rustup target add x86_64-apple-ios aarch64-apple-ios`.
- **Milestone:** `cargo build --target x86_64-apple-ios` succeeds for a scratch crate that depends on `openmls` 0.9.2 and `openmls_rust_crypto`. If this target fails (it is not in OpenMLS CI), stop and report; do not proceed to product integration.

### Phase 1 — Native spike (1–2 weeks)

- UniFFI crate + Expo module skeleton linked into the existing iOS target.
- Two in-process identities on the Simulator: create group, add via KeyPackage, process Welcome, encrypt/decrypt an application message, persist via `openmls_sqlite_storage`, reopen the database, decrypt again.
- Understage still launches in the iPhone 17 Pro Simulator after the module is linked.
- **Milestone:** a recorded round-trip test (host `cargo test` and a Simulator launch) plus a screenshot of the existing app home screen. No product UI copy changes yet.

### Phase 2 — Identity, KeyPackages, AS/DS directory (1–2 weeks)

- Generate the Ed25519 credential on first MLS onboarding; publish signature public key; upload a batch of KeyPackages plus a last-resort package.
- Server endpoints in §4.2 with atomic consume and expiry.
- Safety-number screen can display the MLS number when both users have credentials, without breaking legacy numbers for v1-only contacts.
- Messages still use v1 `nacl.box`.
- **Milestone:** two test accounts; A fetches and consumes B’s KeyPackage exactly once; a concurrent second fetch gets a different package or last-resort; vitest covers the race. TypeScript checks still pass.

### Phase 3 — MLS 1:1 (2–3 weeks)

- Creating or opening a direct conversation between two MLS-capable users builds a 2-member group (Commit + Welcome) and then sends v2 application messages.
- Dual-stack: if either side lacks MLS, keep v1.
- Legacy v1 history still decrypts.
- **Milestone:** two Simulator-backed (or Simulator + Node fixture) accounts send a 1:1 text that the other decrypts after relaunch; server stores one v2 ciphertext; a planted v1 message still opens. Privacy copy still names TweetNaCl for groups.

### Phase 4 — Multi-member groups and the 50-cap lift (2–3 weeks)

- Group create / add / remove go through MLS Commits; DS epoch lock and `EPOCH_CONFLICT` retry work.
- Welcome is never delivered before its Commit.
- Lift the 50-member send cap for **v2-capable** groups only; v1 groups stay at 50.
- **Milestone:** four accounts in one group; add a fifth (they cannot read old application messages; they can read new ones); remove one and confirm they cannot decrypt the next message; two clients committing at once produce one success and one successful retry. Backend tests for epoch conflict are green.

### Phase 5 — Attachments, call signalling, 200-person workspace (1–2 weeks)

- Voice notes and images travel as content keys inside MLS application messages.
- 1:1 call SDP/ICE uses the 2-member MLS group when both sides are v2. Calling remains “untested between two real devices” until that test is actually run.
- Isolated development workspace with ~200 synthetic members; batch-add; one application message stored once; a sample of automated clients decrypt; measure send time, Commit size on add/remove, and memory on the sending Simulator.
- **Milestone:** written numbers from that run. “200-person E2EE workspace chat” may be claimed only after this. Do not insert this fixture into a personal or production-like account.

### Phase 6 — Cutover and copy (about a week)

- Current clients stop issuing v1 when the conversation is v2-capable.
- Reset leftover seed/demo v1 chats used for development.
- Update onboarding and privacy strings to the Phase 6 column in §14.
- **Milestone:** `FEATURE_MATRIX.md` and `ASSUMPTIONS.md` describe MLS as the live protocol, TweetNaCl as historical decrypt, announcements still not E2EE. No visual redesign.

**Total after Phase 0:** roughly 8–12 weeks, dominated by the iOS spike and by membership/epoch edge cases.

---

## 13. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| `x86_64-apple-ios` is not in OpenMLS CI | Cannot develop on this Intel Simulator | Phase 0 compile gate before any integration |
| UniFFI Swift vs Swift 6.2 | The module does not compile next to the existing Expo modules | Wrapper-level Sendability fixes; keep the `expo-modules-jsi` patch; no SDK/Xcode downgrade |
| Lost StorageProvider snapshot (no lock, crash mid-write, restored backup) | Group desynchronised, messages undecryptable | Single-writer lock; SQLCipher/Keychain; treat rollback like a new device and re-join via Welcome |
| Welcome delivered before Commit | Joiner builds an invalid group | Same SQLite transaction; DS rule in §4.3 |
| KeyPackage pool exhausted | Joins fall back to last-resort (weaker freshness) or fail | Watermark replenish; rotate last-resort after use; surface a clear error rather than hanging |
| Dual-stack mix-ups | “Encrypted message” previews, failed history | Version byte first; never cross-feed v1/v2 |
| Claiming Secure Enclave, pre-keys, or Signal protocol | False video parity | §14 |
| Offline for many epochs | Client cannot decrypt until it replays Commits | Persist all Commits; catch-up API; if the client’s state is lost, re-add via a new KeyPackage + Welcome |
| PQ draft suites | Tempting but unfinished | Stay on the MTI suite |

---

## 14. Honest UI copy after each phase

Do not change visual design. Replace a string only when the old one would be false.

The demonstration video talks about identity keys, one-time pre-keys, and the Secure Enclave. Understage may use a phrase only when the matching cell says “allowed”.

| Claim | Now (TweetNaCl) | After Phase 2 (directory only) | After Phase 3 (MLS 1:1) | After Phases 4–6 (groups + 200 tested) | Never unless extra work lands |
|---|---|---|---|---|---|
| “Messages are end-to-end encrypted” | Allowed (1:1 and groups ≤ 50) | Allowed | Allowed | Allowed | — |
| Name the protocol on the privacy screen | Required: TweetNaCl, X25519 + XSalsa20-Poly1305 | Still name TweetNaCl for messages; may say an MLS identity (Ed25519) is also published | 1:1 uses MLS (RFC 9420, the §2 ciphersuite); groups still TweetNaCl until Phase 4 | 1:1 and group chats use MLS (RFC 9420) with X25519-HPKE, AES-128-GCM, and Ed25519 credentials | Do not say “Signal protocol”, “Signal app”, or imply Signal affiliation |
| “One-time pre-keys” | **Forbidden** | **Forbidden.** The analogue is **KeyPackages**. Onboarding may say “publishing KeyPackages so colleagues can add you while you’re offline” once that upload is real | Same | Same | Do not reuse the video’s “pre-keys” wording for KeyPackages |
| “Forward secrecy” | **Forbidden** | **Forbidden** for messages | Allowed for MLS 1:1 once past-epoch secrets are deleted | Allowed for MLS chats; explain that older epochs are discarded | Do not claim FS for leftover v1 history |
| “Post-compromise security” / “self-healing” | **Forbidden** | **Forbidden** | Allowed for 1:1 after a self-Update has been observed, or word as “when this phone updates its group key” | Allowed for groups that perform scheduled self-Updates and membership Commits | Do not claim healing if Updates are never scheduled |
| “Encrypted groups up to 50” | Required | Required | Required for groups | Replace with “up to 200” only after the Phase 5 workspace run | Do not say 200 on the strength of a 5-member test |
| “200-person workspace chats are end-to-end encrypted” | **Forbidden** | **Forbidden** | **Forbidden** | Allowed after Phase 5 | — |
| “Secure Enclave” | **Forbidden** (Keychain via SecureStore) | **Forbidden** | **Forbidden** | **Forbidden** unless an SE-backed wrapping key is implemented and tested. Even then: “wrapped with a Secure Enclave key” or “stored in the iOS Keychain”, not “your identity key lives in the Secure Enclave”. SE does not generate the X25519 HPKE keys MLS uses | Do not match the video’s shorthand while it remains false |
| “Keys are created on this phone” / “saved to iOS Keychain” | Allowed | Allowed; add KeyPackage publish when real | Allowed | Allowed | Do not promise iCloud or server backup of secrets |
| Safety number | Allowed (custom TweetNaCl number) | Show the MLS number when both have credentials; otherwise the legacy number | MLS number for v2 pairs; ask users to re-verify when switching | Allowed | Do not show the old number for a v2 conversation |
| “Attachments are encrypted on this phone before upload” | Allowed | Allowed | Allowed | Allowed | — |
| “Calls are end-to-end encrypted” | Intent only; signalling is `nacl.box`; two-device calling untested | Unchanged | Allowed for signalling once it uses the 2-member MLS group **and** a two-endpoint call has been tested | Same | No CallKit / TURN claims |
| “Announcements are not end-to-end encrypted” | Required | Required | Required | Required | Do not drop this |
| “Independently audited” | **Forbidden** for this app | Allowed only as “OpenMLS was audited by SRLabs in 2026”; never “Understage was audited” | Same | Same | No audit claim for the integration until one exists |
| Multi-device / chats follow a new iPhone | **Forbidden** | **Forbidden** | **Forbidden** | **Forbidden** | Separate project |

Onboarding step labels after Phase 2 (wording only): creating an encryption identity on this phone; generating KeyPackages; publishing the public packages; saving secrets to the iOS Keychain. Do not add a Secure Enclave step or a “one-time pre-keys” step.

---

## 15. References

- Current Understage code: `shared/e2ee.ts`, `src/lib/crypto.ts`, `src/lib/engine.ts`, `src/lib/secure.ts`, `src/lib/calls.ts`, `src/app/(onb)/keys.tsx`, `src/app/(app)/privacy.tsx`, `server/src/app.ts`, `server/src/db.ts`, `ASSUMPTIONS.md`, `FEATURE_MATRIX.md`.
- Prior plan (superseded as the implementation path): `docs/E2EE_SENDER_KEYS_MIGRATION.md`.
- `openmls` 0.9.2 (crates.io, 22 October 2026); `openmls_sqlite_storage` 0.3.0; OpenMLS README ciphersuites and CI targets; OpenMLS 0.9.0 release notes (storage format, MSRV 1.91, draft PQ suites).
- OpenMLS Book: Key Packages; Adding members; Join from a Welcome (do not forward a Welcome before its Commit).
- RFC 9420 (MLS protocol); RFC 9750 (MLS architecture: AS, DS, last-resort KeyPackages).
- SRLabs / Phoenix R&D audit write-up, 27 May 2026.
- rustup installer (`https://sh.rustup.rs`) home-directory install; `rustup target add x86_64-apple-ios aarch64-apple-ios`.

---

*The original design text above was written before any code was changed. Phase 0 later added a throwaway crate at `native/mls-poc` and did not modify the Understage app or server.*

---

## 16. Phase 0 results

**Date:** 5 November 2026, Asia/Karachi (UTC+5).  
**Where:** throwaway crate `native/mls-poc` on the owner’s Intel Mac (`x86_64-apple-darwin`, Xcode 26.3 / Build 17C519). The Understage app, `ios/`, `node_modules`, and running servers were not modified.

### Passed

- rustup **1.29.3** installed into `$HOME` via `https://sh.rustup.rs` with `-y --no-modify-path` (no sudo, no Homebrew). `~/.zshrc` received a guarded `$HOME/.cargo/bin` PATH append that does not duplicate an existing entry.
- Toolchain: **rustc 1.99.1** (58cf8f9c3 2026-10-13), **cargo 1.99.1** (5f94df478 2026-08-27). Both exceed the OpenMLS 0.9 MSRV of Rust 1.91.
- `rustup target add x86_64-apple-ios aarch64-apple-ios` succeeded (21s). Installed targets: `x86_64-apple-darwin`, `x86_64-apple-ios`, `aarch64-apple-ios`.
- Host `cargo test --target x86_64-apple-darwin`: `alice_bob_charlie_roundtrip_and_reload` passed. The test creates Alice and Bob credentials, publishes Bob’s KeyPackage, has Alice create a group and add Bob, has Bob join via Welcome, exchanges application messages both ways, has Alice add then remove Charlie (the removed member cannot decrypt a later message), and persists each party’s state to sqlite then reloads and decrypts again. Locked crates: `openmls` **0.9.2**, `openmls_rust_crypto` 0.6.0, `openmls_basic_credential` 0.6.0, `openmls_sqlite_storage` 0.3.0 (rusqlite bundled), `openmls_traits` 0.6.0. Ciphersuite: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`.
- `cargo build --release --target x86_64-apple-ios` with `SDKROOT` from `xcrun --sdk iphonesimulator` (`iPhoneSimulator26.2.sdk`): success. Cargo reported **1m 48s** (wall 109s). Artifact `native/mls-poc/target/x86_64-apple-ios/release/libmls_poc.a` = **33,878,048 bytes** (~32.3 MiB).
- `cargo build --release --target aarch64-apple-ios` with `SDKROOT` from `xcrun --sdk iphoneos` (`iPhoneOS26.2.sdk`): success. Cargo reported **1m 33s** (wall 94s). Artifact `native/mls-poc/target/aarch64-apple-ios/release/libmls_poc.a` = **34,326,352 bytes** (~32.7 MiB).
- Optional UniFFI check: `uniffi` **0.32.2** generated Swift bindings for one exported function (`ciphersuite_name`). `swiftc -typecheck` against the iphonesimulator 26.2 SDK and `-target x86_64-apple-ios15.0-simulator` succeeded on the first attempt. Generated files: `native/mls-poc/uniffi-check/bindings/mls_poc_uniffi.swift`, `mls_poc_uniffiFFI.h`, `mls_poc_uniffiFFI.modulemap`. UniFFI crate release build took 2m 14s; the overall check took 144s.

### Failed, then fixed

- The first host `cargo test` (94s, including first-time dependency compile) failed with `error[E0599]`: no method named `into_welcome` found for struct `MlsMessageIn`. `MlsMessageIn::into_welcome` exists only under OpenMLS’s own `cfg(test)` / `test-utils`, so it is not visible to a downstream integration test. The helper now matches `MlsMessageIn::extract()` against `MlsMessageBodyIn::Welcome`. The retest compiled in 5.36s and the test passed in 0.46s.

### Blockers

None for the Phase 0 compile gate. The §13 risk that `x86_64-apple-ios` (absent from OpenMLS CI) would fail to build did not materialize. rusqlite’s bundled C sources compiled for both iOS targets with `SDKROOT` and `CC` from `xcrun` plus `IPHONEOS_DEPLOYMENT_TARGET=15.0`; no extra CFLAGS were required.

This does **not** land OpenMLS in the product. Phase 1 remains the UniFFI + Expo module spike linked into the existing iOS target.

Logs: `native/mls-poc/logs/rustup-install.log`, `rustup-targets.log`, `cargo-test-host.log`, `cargo-build-ios.log`, `uniffi-swift-check.log`.

## 17. Phase 1 results

Phase 1 landed a local Expo module (`modules/understage-mls`) that wraps OpenMLS 0.9.2 behind UniFFI, linked it into the existing SDK 58 / RN 0.88.1 iOS target, and exposed a hidden `__DEV__` self-test at `understage://mls-selftest`. It did **not** change server logic or the existing TweetNaCl send path (`src/lib/crypto.ts` is untouched by this phase; production encrypt/decrypt still goes through nacl). Expo SDK remains `~58.0.23`, React Native remains `0.88.1`, `EXPO_USE_PRECOMPILED_MODULES=0` (and `"false"` in `ios/Podfile.properties.json`), and `patches/expo-modules-jsi+58.0.22.patch` is intact.

Working Simulator app was copied first to `~/Downloads/understage-app-backup/Understage-sim-20261105-160925.app` (not needed for restore; the rebuild succeeded).

### What shipped

- Rust crate at `modules/understage-mls/rust` (OpenMLS 0.9.2 + `openmls_basic_credential` 0.6.0 with `clonable` + `openmls_rust_crypto` 0.6.0 + `openmls_sqlite_storage` 0.3.0 + UniFFI 0.32.2). `MlsSession` exports: open storage at a path with a 32-byte wrapping key, generate a credential and signing key, export a KeyPackage, create a group, add a member (Commit + Welcome + epoch), join from a Welcome, process an incoming message or commit, encrypt/decrypt application messages, remove a member, and read the epoch. Group state lives in sqlite; identity + signer + group id are sealed to `{storage_path}.vault` with AES-256-GCM.
- `modules/understage-mls/scripts/build-rust.sh` is the clean-clone path: host `uniffi-bindgen`, Swift bindings into `ios/generated/`, `x86_64-apple-ios` (iphonesimulator) and `aarch64-apple-ios` (iphoneos) staticlibs, then `xcodebuild -create-xcframework` → `ios/MlsCore.xcframework`.
- Swift Expo module (`@ExpoModule("UnderstageMls")`) wrapping the generated UniFFI API. Swift 6.2 choices are marked in comments: `@JS(.concurrent)` methods are not MainActor-isolated; sessions live in an `@unchecked Sendable` `SessionBox` guarded by `NSLock`; Keychain access is isolated to `@MainActor`.
- App-facing TS API at `src/lib/mls.ts` (no `file:` dependency; `requireNativeModule('UnderstageMls')`). Hidden route `src/app/mls-selftest.tsx` registered as an unprotected `Stack.Screen` in `src/app/_layout.tsx` so `understage://mls-selftest` works regardless of auth.
- The module is autolinked by Expo’s default `nativeModulesDir` (`./modules`); root `package.json` / `package-lock.json` were not changed, so a clean `npm ci` still matches the lockfile.

### Build and test

- Host `cargo test` in `modules/understage-mls/rust`: `alice_bob_welcome_encrypt_decrypt_remove` passed (0.25s). Log: `modules/understage-mls/logs/cargo-test-host.log`.
- `scripts/build-rust.sh` under `caffeinate`: **BUILD_RUST_EXIT 0** at Thu Nov 5 16:35:28 PKT (Asia/Karachi). XCFramework ≈ 75 MB; `ios-x86_64-simulator/libunderstage_mls.a` ≈ 37 MB; `ios-arm64/libunderstage_mls.a` ≈ 38 MB. Log: `modules/understage-mls/logs/build-rust.log`.
- `pod install` with `LANG=en_US.UTF-8`, `PATH` including `$HOME/.gem/ruby/2.6.0/bin` and `$HOME/.local/node/bin` (Node v22.23.4), `EXPO_USE_PRECOMPILED_MODULES=0`: **POD_INSTALL_EXIT 0** at Thu Nov 5 16:39:13 PKT. Installed `UnderstageMls (0.1.0)`; 136 pods total. Log: `logs/pod-install-mls-phase1.log`.
- `xcodebuild` (generic iOS Simulator, `ARCHS=x86_64`, `-derivedDataPath build/dd`, `CODE_SIGNING_ALLOWED=NO`) under `caffeinate`, same command as `logs/rebuild.sh`:
  - `logs/ios-build-20261105-163926.log` — **BUILD_EXIT 65**. Two Swift errors: missing `return` in `encrypt` / `decrypt` (implicit return does not apply to multi-statement functions). Fixed.
  - `logs/ios-build-20261105-164438.log` — **BUILD_EXIT 0** at Thu Nov 5 16:45:32 PKT.
  - `logs/ios-build-20261105-165029.log` — **BUILD_EXIT 0** (Keychain MainActor hop).
  - `logs/ios-build-20261105-165430.log` — **BUILD_EXIT 0** at Thu Nov 5 16:55:15 PKT. This is the binary that was installed and self-tested. Latest symlink: `logs/ios-build-latest.log`.
- App size after the final Debug-iphonesimulator build: **178 MB** (`ios/build/dd/Build/Products/Debug-iphonesimulator/Understage.app`).
- `xcrun simctl install booted` of that app succeeded on the booted iPhone 17 Pro (iOS 26.3.1). After connecting the Expo dev client to Metro at `http://localhost:8081`, `understage://mls-selftest` showed **PASS** with `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 · epoch 1 · Alice ↔ Bob application messages`. Screenshot: `shots/mls-selftest.png` (also copied to the box at `/workspace/uploads/sim2/mls-selftest.png`).
- Reopening the running app after the install still landed on **Chats** (On shift, existing TEST threads). The production nacl path was not exercised by the self-test and was not modified.

### Clean clone / `npm ci`

- Root `package.json` `postinstall` is `patch-package`. `patches/expo-modules-jsi+58.0.22.patch` is present (16,552,142 bytes). A clean `npm ci` would therefore reapply the Swift 6.2 patch; `npm ci` was **not** run in this phase (it would rewrite `node_modules` while another worker is using Metro).
- From a clean clone, after Phase 0 rustup + the `x86_64-apple-ios` and `aarch64-apple-ios` targets: run `./modules/understage-mls/scripts/build-rust.sh`, then `pod install` with the env above, then the same `xcodebuild`. The script is the only supported way to produce `ios/MlsCore.xcframework` and `ios/generated/`.

### Failed, then fixed

- Host compile first failed with missing `tls_codec::{Serialize, Deserialize}` (those traits collide with `serde`’s same names; they are imported as `TlsSerialize` / `TlsDeserialize`) and E0502 provider/group double-borrows in `add_member`, `process_incoming`, `encrypt`, and `remove_member`. Fixed by destructuring `SessionInner` into disjoint fields.
- First `xcodebuild` failed with missing `return` in `encrypt` and `decrypt`; fixed and rebuilt.
- The first on-device self-test printed **FAIL**: `Keychain read failed with status -34018` (`errSecMissingEntitlement`). This unsigned Simulator build uses `CODE_SIGNING_ALLOWED=NO`, so the process has no `application-identifier` entitlement. Hopping Keychain to the MainActor did not clear it. `MlsWrappingKey` now tries the Keychain first (same query shape as `expo-secure-store`) and, on `-34018` only, falls back to a 32-byte key file under Application Support with `completeFileProtectionUntilFirstUserAuthentication`. Signed device builds, which inject the entitlement, still use the Keychain. After that fallback the self-test printed **PASS**.

### Blockers

None that block Phase 1. Two limitations to carry into Phase 2:

1. Unsigned Simulator Keychain (`CODE_SIGNING_ALLOWED=NO`) cannot store the wrapping key (`errSecMissingEntitlement` / -34018); the file-protection fallback covers this build. A signed device build should be re-checked so the Keychain path is the one that runs in production.
2. `understage://mls-selftest` is intercepted by Expo Dev Launcher if the JS app is not already connected to Metro. Connecting via `understage://expo-development-client/?url=http://localhost:8081` first, then opening the self-test link, routes correctly.

This does **not** replace production group encryption. Phase 2 remains wiring MLS groups through the Delivery Service without dropping the nacl dual-stack.


## 18. Phase 2 results

**Date:** 5 November 2026, Asia/Karachi (UTC+5).  
**Where:** the live checkout at `~/Downloads/understage-app` (server AS/DS + client publish hook). No native rebuild. Expo SDK remains `~58.0.23`, React Native remains `0.88.1`, `EXPO_USE_PRECOMPILED_MODULES=0`, and `patches/expo-modules-jsi+58.0.22.patch` are unchanged. UI visuals were not touched (`src/app/(onb)/keys.tsx` STEPS and the safety-number screen layout stay as they were).

Phase 2 landed the Authentication Service / Delivery Service directory behind a feature flag that defaults **off**, so the existing TweetNaCl path keeps working.

### Feature flag

- Server: `Config.mlsDirectoryEnabled` from `MLS_DIRECTORY_ENABLED === '1'` (`server/src/config.ts`). `loadConfig` still applies `...over` last, so tests can force the flag on.
- Client: `MLS_DIRECTORY_ENABLED = process.env.EXPO_PUBLIC_MLS_DIRECTORY === '1'` in `src/lib/mls.ts` (default off).
- When the flag is off, MLS routes return HTTP 404 `{ error: 'MLS_DISABLED' }`, `publicUser` does not add MLS fields (existing JSON shape is unchanged), and `ensureKeys` still only publishes the nacl identity via `PUT /me/keys`.
- `GET /health` gained an additive `mlsDirectory: boolean` (false by default).

### What shipped

**Schema** (`server/src/db.ts`, additive; `migrateMls` ALTERs missing user columns on existing files):

- `users`: `mls_signature_key`, `mls_credential_identity`, `mls_key_updated_at`.
- Tables: `mls_key_packages`, `mls_groups`, `mls_messages`, `mls_welcomes`, plus indexes on user/package, conversation/epoch, and welcome recipient.

**AS/DS HTTP** (`server/src/mls.ts`, registered from `server/src/app.ts` just before `buildApp` returns):

- `PUT /me/mls/credential` `{ signaturePublicKey, credentialIdentity }` — identity must equal `req.userId`; rotating the signature key clears other users’ `verified` flags against this user.
- `POST /me/key-packages` — body `{ packages: [...] }` or a raw array. Fields: `ciphertext`, optional `hashRef` (must equal SHA-256 of the decoded ciphertext), `lastResort`, `notBefore`, `notAfter`, optional `credentialIdentity`. Lifetime must be ≤ `3 × 28 days + 1 hour`. Uploading a new last-resort package deletes the previous one for that user.
- `GET /me/key-packages/status` — `{ ordinaryRemaining, lastResortRemaining, lastResortUsed, lastResortLastUsedAt, ciphersuite }`.
- `GET /users/:id/key-package` — atomically `DELETE … RETURNING` the oldest unused, unexpired ordinary package; otherwise return the last-resort package without deleting it and set `last_used_at`. Rate-limited (60/min). 403 if blocked; 404 `KEY_PACKAGE_UNAVAILABLE`.
- `POST /conversations/:id/mls/commits` `{ epoch, commit, commitId?, groupId?, welcomes: [{ recipientId, body }] }` inside a better-sqlite3 `.immediate()` transaction: accept if the stored epoch is null (creating commit) or equals `E`, write the commit, set epoch to `E+1`, and store welcomes in the same transaction; otherwise HTTP 409 `{ error: 'EPOCH_CONFLICT', epoch, winningCommit, catchUp }`. Then emit `mls:commit` to members and `mls:welcome` to recipients.
- `GET /conversations/:id/mls?after_epoch=&after_id=` — ordered handshake: commits then welcomes at the same epoch; welcomes only for `req.userId`.

The Node server does **not** decode MLS TLS KeyPackages (no OpenMLS on Node). It stores opaque base64 plus client metadata and checks auth, `hashRef`, lifetime, expiry, and optional `credentialIdentity === req.userId`.

**Client** (gated; no-ops when the flag is off or the native module is absent):

- `publishMlsKeyPackagesAfterKeygen(userId)` opens `${documentsDirectory()}/mls/${userId}.sqlite`, calls `generateCredential` (ignores “already present”), exports 20 ordinary KeyPackages plus one last-resort, and `POST`s them to `/me/key-packages`.
- `ensureKeys` still does `PUT /me/keys` first. When the flag is on it then calls the publisher; a skip (`disabled` / `native-unavailable`) does not fail nacl onboarding.
- Safety-number screen (`src/app/(app)/safety/[id].tsx`) keeps the same layout. The number source is now `conversationSafetyNumber` in `shared/e2ee.ts`, which prefers `mlsSafetyNumber` (label `understage-mls-safety-v1:`, 60 digits / 12 groups via `nacl.hash`) when both sides have `mlsSignaturePublicKey`, else the legacy TweetNaCl `safetyNumber`.
- `PublicUser` gained optional `mlsSignaturePublicKey`, `mlsCredentialIdentity`, `mlsKeyUpdatedAt` (`src/lib/types.ts`).

### Native module API (not rebuilt)

The Phase 1 UniFFI API does **not** export the Ed25519 signature public key (`generateCredential` returns void; `exportKeyPackage` returns the base64 KeyPackage only). Phase 2 was asked not to rebuild unless the API *must* change, and to report back first if it must.

The directory therefore:

- Publishes KeyPackages from the client when the flag is on and the module is present.
- Implements `PUT /me/mls/credential` on the server for tests and for a later native export.
- Does **not** invent a JS-side signature key (that would diverge from OpenMLS) and does **not** call `PUT /me/mls/credential` from `publishMlsKeyPackagesAfterKeygen` yet.

Publishing a real OpenMLS signature public key from a production client will need a small UniFFI addition (for example `exportSignaturePublicKey() -> String`) and one native rebuild. That is the ask for a later phase; Phase 2 did not rebuild.

The native API also cannot `mark_as_last_resort()` on a KeyPackage. Last-resort is a client-provided boolean stored by the DS.

### Tests and typecheck

Ran on the owner’s Mac from `~/Downloads/understage-app`:

- `cd server && npm test` (vitest 4.1.12): **4 files, 35 tests, all passed** (duration 3.44s on the final run after the type fix). New file `server/test/mls-directory.test.ts` (9 cases):
  1. Flag off keeps the nacl `PUT /me/keys` path working, hides MLS endpoints (`404 MLS_DISABLED`), and omits `mlsSignaturePublicKey` from `/me`.
  2. Two clients publish credentials and fetch each other on `GET /users/:id`.
  3. Credential identity mismatch → 400 `IDENTITY_MISMATCH`.
  4. Ordinary KeyPackage is single-use; last-resort is reused and `lastResortUsed` becomes true.
  5. Two concurrent fetchers of two ordinary packages get different `hashRef`s (neither last-resort).
  6. Expired packages, oversized lifetimes, and `hashRef` mismatches are rejected.
  7. Two clients exchange a Commit + Welcome over HTTP: Alice’s catch-up sees only the commit; Bob’s sees the commit then his welcome; socket events `mls:commit` / `mls:welcome` fire.
  8. Concurrent commits at epoch 0 return `[200, 409]`; the loser retries at epoch 1 and the group reaches epoch 2. The 409 body includes `EPOCH_CONFLICT`, `winningCommit`, and `catchUp`.
  9. Welcome ordering: a Welcome is never returned before its Commit; `after_epoch=0` omits the epoch-0 commit and still places the Welcome after its Commit.
- `cd server && npm run typecheck` (`tsc --noEmit`): **exit 0** (after typing the credential helper as `TUser` instead of `{ id, token }`).
- Root `npm run typecheck` (`tsc --noEmit`): **exit 0** (already clean on the first run).

### Failed, then fixed

- The first server `tsc` reported `TS2739` in `test/mls-directory.test.ts`: `H()` expects `TUser` (`id`, `token`, `refresh`, `id_`, `username`) but the helper was typed as `{ id: string; token: string }`. Fixed by importing `TUser`. Retest and `tsc` then passed. No production code change.

### Blockers

None that block Phase 2. Carry-forward:

1. No signature-public-key export on the UniFFI / Expo module (see above). Server and tests cover the endpoint; a production client cannot yet publish its real OpenMLS credential key without a native API addition and rebuild.
2. KeyPackages on the server are opaque (no TLS parser / OpenMLS-on-Node). Lifetime, expiry, hash, and identity checks match §4 as closely as possible without decoding the package.
3. Production message send/receive is still TweetNaCl. Phase 2 does not create MLS groups on the send path; that remains Phase 3 (MLS 1:1) and Phase 4 (multi-member groups and the 50-cap lift).

This does **not** replace production group encryption. Enable the directory only by setting `MLS_DIRECTORY_ENABLED=1` on the server and `EXPO_PUBLIC_MLS_DIRECTORY=1` on the client.
