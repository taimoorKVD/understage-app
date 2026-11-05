

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
