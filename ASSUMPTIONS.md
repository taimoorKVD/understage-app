# Assumptions

- **Sources of truth:** the prototype in `/workspace/understage/live` (app.html, app.js, extra.css, admin.js) and screens 00–41.png. Where the prototype and the video disagree, the prototype wins.
- **E2EE model** (no custom crypto, only TweetNaCl primitives):
  - Each device has an X25519 identity key. Private keys are stored in the iOS Keychain via expo-secure-store.
  - Every message is encrypted per recipient with `nacl.box` (fan-out). The sender's own copy is included.
  - Attachments use `nacl.secretbox` with a random key, and that key travels inside the boxed message.
  - Call signalling (SDP/ICE) is sealed with `nacl.box`. Media uses WebRTC DTLS-SRTP.
  - This is **not** the Signal protocol: there's no forward secrecy or ratchet, and there's no multi-device support. A new phone means a new key, and contacts see a "safety number changed" notice.
  - Safety numbers or a QR code let contacts verify each other.
- **Group limits:** encrypted groups are limited to 50 members (fan-out cost). Workspace company chats follow the same rule.
- **Announcements are not E2EE.** Admins need server-side acknowledgement tracking, and quiet-hours holding needs the server to read announcements. The UI says so in the compose screen.
- **Abuse reports:** messages are included as evidence only when the reporter chooses. They are decrypted on the reporter's phone and sent with the report.
- **Plans:**
  - Crew (free) can't create workspaces. The app sends free users to the paywall. The server does **not** enforce a plan on `POST /workspaces`; that gap is known.
  - Seat limits are 50 for Production and 200 for Company.
- **Wrap:** a wrapped workspace is read-only, invite links stop working, and the server marks it for deletion after 30 days. The purge job is a server concern; see the server code.
- **Working hours:** "off shift" with quiet hours on means pushes are held and released at shift start, using the recipient's own timezone.
- **Web admin:** the admin UI from admin.js is **backend-only**. The `/admin/*` endpoints exist and are tested, but there's no web front-end.
- **Support:** I added `GET /support/tickets/:id` (user-scoped) so the app can show a ticket's thread. It's covered in vitest.
- **API URL:** configured by `EXPO_PUBLIC_API_URL` in `.env` (via `app.config.ts`); dev builds fall back to the Metro host IP, then `localhost` (Simulator only). Server listens on `0.0.0.0`.

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
