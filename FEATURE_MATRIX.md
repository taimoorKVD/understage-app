# Feature matrix

"Tested" means covered by server vitest (16 tests) and/or the smoke script (16 checks against the live server), plus app `tsc` and `expo export`. **No feature has been run on an iOS device or simulator** (no macOS/Xcode in this environment), so every app UI is at best "Implemented, untested on device".

## Implemented + tested (backend logic verified by vitest/smoke; UI wired, but not run on a device)
- Phone/email OTP sign-in, JWT access/refresh, sessions revoked on suspension
- Profile, username check, work identity, working hours, timezone and touring mode (`PATCH /me`)
- Identity key upload, key-change events, safety-number verification
- E2EE 1:1 and group messaging: fan-out envelopes, sequence sync, delivered/read receipts, typing (Socket.IO)
- Offline outbox with retry and discard (shared `outbox.ts`, vitest)
- Contacts: search, add, QR invite tokens (resolve/accept), block/unblock, report
- Groups: create, rename, add/remove members, roles, leave, 50-member limit
- Workspaces: create, departments, member directory (search/filter, role and department changes, remove), workspace invites, seat limit
- Announcements: department targeting, require-ack, quiet-hours holding, seen/ack/remind, live ack counts
- Wrap production (read-only, invites disabled)
- Held notifications / release at shift start
- Call history, ICE config endpoint
- Subscriptions: plans; verify refuses with 501 when not configured
- Support tickets (create/list/thread/reply); admin moderation API (backend-only)

## Implemented, untested on device
- All screens: chats list, chat (text, voice notes, photos, documents, contact cards, failed-send retry), safety number, add contact, My QR, QR scanner, invite, new group, workspace tab/detail/compose/ack tracker/settings with wrap, calls tab, settings, edit profile, working hours, privacy, blocked, report → reported, support
- Push token registration and notification routing (needs APNs + EAS project)
- Encrypted attachment upload/download on device file system

## Partial
- **Voice calls:** WebRTC with sealed signalling is implemented. It needs a dev build, has never been run between two devices, and has no CallKit/VoIP push.
- **Speaker/earpiece routing:** uses expo-audio `shouldRouteThroughEarpiece`. Reliability alongside WebRTC audio is unverified.
- **In-app purchase:** the StoreKit flow via expo-iap is written. Server receipt validation is not implemented (501), and a dev-only trial exists behind `SUBSCRIPTIONS_DEV=1`.
- **Plan gating for workspace creation:** client-side only.
- **ESLint:** `eslint src` is clean (0 errors, 0 warnings). 11 narrowly scoped `eslint-disable` comments remain, each with a reason (optional native `require`s, intentional effect deps).
- **Group leave:** the server removes the member; the app doesn't drop the conversation locally (see below).

## Blocked (needs credentials/infrastructure)
- Real SMS delivery (Twilio creds)
- APNs push delivery (Apple key + EAS project)
- TURN relay (server/creds)
- App Store purchases (App Store Connect products + Server API keys)
- On-device testing (needs macOS + Xcode; README has the steps. EAS was not used, because it consumes external credits)

## Not production-ready

This build is a development prototype. Do not ship it as-is. Known gaps:

- **Calls (WebRTC/TURN):** WebRTC with sealed signalling is written but has never been run between two devices. Only STUN by default; no TURN server is configured, so calls across different NAT'd networks will often fail.
- **CallKit / VoIP push:** not implemented. Incoming calls only ring while the app is open in the foreground; no lock-screen call UI, no PushKit.
- **Encryption limits:** TweetNaCl `box`/`secretbox` per-recipient fan-out. Not the Signal protocol: no forward secrecy or ratchet, no multi-device, not independently audited. Announcements are not E2EE. Metadata (who talks to whom, when, group membership) is visible to the server.
- **Push / APNs:** token registration and routing code exist; delivery is untested — needs an APNs key, an Expo project id and `EXPO_PUSH_ENABLED=1`.
- **SMS / Twilio:** the Twilio sender is written but untested; dev prints the OTP to the server log.
- **IAP receipt validation:** not implemented — `/subscriptions/verify` returns `501` (dev-only trial behind `SUBSCRIPTIONS_DEV=1`). App Store products are not created.
- **Web admin dashboard:** UI not built. Only the `/admin/*` API exists (tested).
- **Group leave refresh:** after "Leave group" the app navigates away but does not remove the conversation from local state; the list may still show it until the next sync/restart.
- **Server-side plan check:** `POST /workspaces` doesn't check the plan; gating is client-side only.
- **On-device testing:** nothing has been run on a real iPhone yet; behaviour is verified only by tsc, eslint, vitest, the smoke script and an iOS bundle export.
- **Ops:** single SQLite file, no backups, no rate-limit tuning, no HTTPS termination (use a reverse proxy/tunnel).
