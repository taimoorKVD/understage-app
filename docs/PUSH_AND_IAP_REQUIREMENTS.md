# Push notifications and In-App Purchase requirements

This document describes what is implemented in the repo versus what still needs Apple (or other external) setup. Nothing here purchases a membership or a paid service.

## Push notifications (APNs / Expo)

Foreground 1:1 chat does **not** depend on push. Incoming `message:new` / `message:status` events ride the Socket.IO WebSocket (`transports: ['websocket']`) while the app is active, and a reconnect catch-up uses `GET /sync?since=` plus a refetch of loaded conversation history so delivered/read ticks are not lost when `/sync` has no new seq.

Background / killed-app delivery **does** require APNs:

| Requirement | Status on this Personal Team install |
| --- | --- |
| Apple Developer Program membership (paid) | Not purchased. Do not buy without explicit permission. |
| `aps-environment` entitlement | The free Personal Team (`7SH4DAD2LV`) cannot sign it. The current `com.kvmac.understage` development build therefore cannot register for remote notifications. |
| APNs key (`.p8`) uploaded to Expo or used directly | Not configured. |
| Expo push token stored via `POST /push/tokens` | Client attempts this; `expo-notifications` logs `Error reading persisted server registration info` on this unsigned build. Expected. |
| Server `notify()` → Expo / APNs | Code path exists; without a token and a provider it cannot deliver. Quiet-hours / off-shift hold-and-release is unit-tested independently of APNs. |

Do not treat a missing banner while the app is backgrounded as a chat bug. That is the APNs gap, not a Socket.IO failure.

### What to do later (when a paid team is approved)

1. Enroll in the Apple Developer Program and create an App ID with Push Notifications.
2. Create an APNs Auth Key in App Store Connect / Certificates, Identifiers & Profiles.
3. Add the `aps-environment` entitlement (`development` for sandbox, `production` for TestFlight / App Store).
4. Configure Expo credentials (`eas credentials`) **or** point the server at the APNs key. This project does not require EAS or a paid Expo plan to implement the hooks; uploading the key is a separate decision.
5. Confirm `POST /push/tokens` stores a token from a physical device and that a backgrounded phone receives `New encrypted message` (the server never puts plaintext in the push body).

## In-App Purchases (App Store Server API JWS)

`POST /subscriptions/verify` verifies an App Store Server API **signed transaction JWS** locally against a configured Apple root CA chain. It does **not** call App Store Connect and does **not** need `APPSTORE_ISSUER_ID` / `KEY_ID` / `PRIVATE_KEY` to decide whether a presented JWS is authentic.

| Condition | HTTP | Entitlement |
| --- | --- | --- |
| No trusted roots configured (`APPLE_ROOT_CA_PEM` / `APPLE_IAP_ROOTS_DIR` unset, and `IAP_VERIFY_ENABLED` not `1`) | `501 IAP_NOT_CONFIGURED` | Not granted |
| Roots configured, but `signedTransaction` missing or invalid, chain untrusted, signature mismatch, wrong `bundleId`, unknown `productId` | `400 IAP_UNVERIFIED` | Not granted |
| Valid JWS whose `expiresDate` is in the past | `400 IAP_EXPIRED` | Not granted (existing plan is left unchanged) |
| Valid JWS for `com.understage.production.monthly` or `com.understage.company.monthly` | `200` | `plan_status='active'`, `plan_renews_at=expiresDate` |

`SUBSCRIPTIONS_DEV=1` plus `{ dev: true }` **no longer grants a trial**. That path was an unverified bypass and has been removed.

### Enabling verification

1. Download Apple Root CA – G3 (and any newer Apple PKI roots you need) from [Apple PKI](https://www.apple.com/certificateauthority/).
2. Provide them as PEM:
   - `APPLE_ROOT_CA_PEM` (one or more `BEGIN CERTIFICATE` blocks), or
   - `APPLE_IAP_ROOTS_DIR` pointing at a directory of `.pem` / `.crt` files, or
   - drop `apple-root-ca-g3.pem` in `server/certs/` and set `IAP_VERIFY_ENABLED=1`.
3. Optional: `APPLE_BUNDLE_ID` (defaults to `com.kvmac.understage`). The JWS `bundleId` must match.
4. The app should send `{ signedTransaction, planId?, transactionId? }`. `planId` / `transactionId` are checked against the verified payload when present; they are not trusted on their own.
5. Product IDs that must exist in App Store Connect (sandbox or production) before a real device can produce a JWS:
   - `com.understage.production.monthly` → Production plan (50 seats, £49/month sample)
   - `com.understage.company.monthly` → Company plan (200 seats, £149/month sample)

Creating those products, signing a StoreKit configuration, or using a sandbox Apple ID are App Store Connect steps. They are not required for the unit tests, which mint a local P-256 root + intermediate + leaf and sign a fixture JWS.

### What this does not do yet

- Fetch transactions from the App Store Server API (that **would** need an In-App Purchase key from App Store Connect).
- Handle App Store Server Notifications V2.
- Google Play Billing (out of scope for this iOS app).
- Grant or renew a plan because the client sent a raw `transactionId`.
