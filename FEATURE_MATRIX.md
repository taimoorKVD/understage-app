# Feature matrix

Updated 2026-11-05 20:34 (Asia/Karachi) after t37u (photo attach path, Alex voice decrypt, request logging, deep-link fix, contact-accept idempotency), building on the 19:56 workspace-join/ack update, the 19:40 realtime-messaging pass and Batch 2. Statuses describe the **current codebase**. The app is **not** production-ready.

**Verified split of the video's 22 features**

| Bucket | Count | Share | Items |
| --- | --- | --- | --- |
| Device-verified on the physical iPhone | 5 / 22 | **23%** | 1 OTP auth, 2 work profile, 6 add-by-@username (not camera QR), 7 1:1 encrypted messages + delivered/read, 13 workspace join + required ack |
| Simulator / API / Chrome verified, not repeated on this iPhone | 14 / 22 | **64%** | 3, 4, 8–10 (8: outgoing voice note observed on device), 12, 14–19, 21–22 |
| Partial vs the video / not fully verified | 3 / 22 | **14%** | 5 key setup, 11 calls, 20 subscriptions / IAP |

Workflow-level implementation is still about **19 / 22 (86%)** (items 5, 11, and 20 remain partial). OpenMLS phases 0–2 are in the tree with `MLS_DIRECTORY_ENABLED` off (`mlsDirectory: false` on `/health`); Phase 3 has not started. Encrypted groups stay capped at 50 members until MLS. Calls have not been verified between two real devices; a LAN test plan is in `docs/WEBRTC_TWO_DEVICE_TEST.md`. The free Personal Team (`7SH4DAD2LV`) cannot sign `aps-environment`, so APNs / Expo push cannot be shipped on this install. `POST /subscriptions/verify` verifies a signed App Store transaction JWS against configured Apple root CAs and returns `501 IAP_NOT_CONFIGURED` when no roots are configured; it never grants a plan without a verified JWS (`docs/PUSH_AND_IAP_REQUIREMENTS.md`).

**Tested on the physical iPhone (this evening):** USB-unplugged Wi-Fi runtime, wireless `devicectl` relaunch, session restore without a new OTP, Keychain identity persistence (no sandbox file fallback), Chats compose/send to `@alex.rivera300`, server-side ciphertext-only storage, second-account decrypt + encrypted reply, **live foreground delivery** (Alex → phone delivered in 149 ms while the chat was open; user replied “Ohh ok”), **live read ticks** (Alex marked that reply read and the phone cache showed `status=read` / `read_by=1` within ~3 s, no relaunch), reconnect after a brief server/network interruption (425 ms), and HTTP catch-up of an offline-sent probe after terminate+relaunch with no duplicate message ids in the server DB or phone cache. An outgoing voice note (`audio/m4a`, `a_-UWatBfHbE9K`, seq 13, `m_uhp2e7f3zETG`) was stored; as Alex it decrypted to a valid M4A (`ftyp:M4A`, ffmpeg `mov`/`aac`, 3.46 s) and was marked delivered+read. At 20:01:41 PKT the phone sent image `m_lHUykMKhNxkR` (seq 16) with attachment `a_5rRRRe9pxbJq` (`image/png`, valid PNG magic) which Alex decrypted (`validImage: true`). The 19:45–19:52 PKT window had no image upload and no Metro picker/upload/encrypt/413 errors — that miss was skip, cancel, or permission-deny, not a broken encrypt/upload path. At 19:46:09 PKT the phone user joined isolated TEST workspace `w_M2IFshcmKU84` as a `member` after accepting invite `i_g45sG0MQc2Cg`; the watcher assigned Stage Management (`d_fUMdmARHgRig`) and posted require-ack announcement `n_HHPqfNM-ft7_` (“Call sheet — please acknowledge”, 199 recipients) at 19:46:14 PKT. The phone recipient `seen_at` is 19:46:14 PKT and `acked_at` is 19:47:04 PKT (API as Alex: 1/199 acked). Dev-only Fastify request logging is on (`[http] METHOD path status ip`, query strings stripped, no bodies or tokens; off in production/test unless `REQUEST_LOG=1`). Around 20:30 PKT the phone issued `GET /calls 200` twice (Calls tab focused). Settings still has no mount fetch, so a visual confirm is still required. Camera QR scan of Alex was not exercised. Alex’s My QR was opened on the booted Simulator (signed in as Alex) at 19:54:28 PKT, minting contact invite `i_QISQK_Ma7dUG` and revoking prior unused Alex contact invites; a screenshot of that screen is on the Mac display and at `/workspace/uploads/alex-qr.png` for the physical camera. Simulator, vitest, and Chrome admin results from Batch 2 still stand. CallKit, real IAP sandbox purchases, APNs background delivery, camera QR scan of Alex, and a two-device call were not run.

## Plans

| Plan | Price | Seats | Server enforcement (this batch) |
| --- | --- | --- | --- |
| Crew (`free`) | £0 | 0 | Cannot `POST /workspaces` (`403 PLAN_REQUIRED`). |
| Production | £49/month | 50 | Create allowed; `seatLimit` clamped to 50. Product id `com.understage.production.monthly`. |
| Company | £149/month | 200 | Create allowed; `seatLimit` clamped to 200. Product id `com.understage.company.monthly`. Announcements, acks, wrap, admin tools. |

Entitlement is read from the same `users.plan` / `plan_status` / `plan_renews_at` state as `GET /subscriptions/me`. Expired or cancelled trials are treated as free (0 seats). App Store JWS verification is implemented but stays `501` until Apple root CAs are configured; unverified `transactionId` / `{dev:true}` payloads never grant a plan.

Encrypted **group** chats are capped at **50 members** (`GROUP_TOO_LARGE_FOR_E2EE`) on create, add-members, and send. Workspace company chats can have up to 200 members but are not E2EE at that size: `serializeConv` returns `e2eeError: "GROUP_TOO_LARGE_FOR_E2EE"` with the **full** member list (the old `LIMIT 50` truncation is gone) and clients show a composer notice to use announcements instead.

## The video's 22 features

Statuses: Fully implemented and verified · Implemented but untested · Partially implemented · Missing · Different from video · Blocked by external infrastructure.

1. **OTP auth (phone/email)** — Fully implemented and verified (server vitest + physical iPhone). The phone user completed OTP, kept session `s_HRuaqu9pf4Z2` (created 18:43:37 PKT) across USB-unplug and a wireless relaunch, and was not issued a new OTP. SMS/email delivery is still blocked without a provider (dev returns the code).
2. **Work profile (name, @username, role/dept)** — Implemented (screens + `PATCH /me`) and completed on the physical iPhone: display name Syed Umar, handle `syed.umar`, `profileComplete` true, timezone Asia/Karachi. Role/department/avatar were left empty. Different from video: five onboarding steps vs the video's four.
3. **Work identity visibility list** — Implemented but untested on device this batch.
4. **Working hours, timezone, touring mode, quiet hours** — Implemented. Timezone / shift math verified by vitest (`isOnShift`). Simulator timezone display was checked earlier.
5. **Key setup (identity key, one-time prekeys, Secure Enclave)** — Partially implemented. On the physical iPhone the X25519 identity key was created, published, stored in Keychain (no `Documents/understage_secure_*.json` file fallback), and kept the same SHA-256 fingerprint `fd8f10e4997f582dda2030f9ded1fc9f7a75214fb30c6d56f4dc7986d2fccffb` across terminate/relaunch, including the 19:07:21 PKT wireless relaunch. No Signal-style one-time prekeys and no Secure Enclave wrapping. TweetNaCl `box`/`secretbox` only.
6. **Add contact by @username + toast + camera QR scan** — Implemented. Physical iPhone: the user added `@alex.rivera300` and opened a direct chat (`c_kthwzfur3ztd`). Username search therefore works on device. Camera QR scan was not exercised. Server invite/QR cases are vitest-covered; regenerate-revokes-previous remains wired.
7. **1:1 messages, typing, sent/delivered/read ticks** — Implemented and verified on the physical iPhone with a second authenticated account (Alex Rivera `@alex.rivera300`). Earlier this evening the phone sent encrypted “Hii”, “Test message”, and “How are you bro?”; Alex decrypted them with the published identity (keys were not rotated) and sent ciphertext-only replies. Realtime fixes (websocket-only transport, auth refresh on reconnect, AppState/NetInfo `wakeRealtime`, 12 s socket watchdog, `applyMessageStatus` cache fallback, `syncOutgoingReceipts` after `/sync`, `mergeMessageList` dedupe, server ping 10 s / 8 s) were loaded via Metro and a wireless relaunch at 19:27:41 PKT (PID 1516). Live foreground: Alex sent `m__tqbargVhgt5` (“realtime-probe 2026-11-05 19:28:26 PKT”) while the phone had an ESTABLISHED `:4000` socket and the chat open; the phone’s `delivered_at` was 149 ms later; the user read it and replied “Ohh ok” (`m_gOOscrUmjH6I`, seq 12). Live ticks: Alex marked seq 12 delivered+read at 19:30:03 PKT; a cache copy at 19:30:09 PKT showed `status=read` / `read_by=1` with no duplicate ids. Older phone outbound messages were already `read` after the 19:27 relaunch via receipt catch-up (`/sync` cannot replay receipt-only updates because seq does not advance). Reconnect: the `:4000` listener was interrupted and restored at 19:31:59 PKT; the phone reconnected and Alex’s `m_RbEPEbbOZ4jl` (seq 14) was delivered+read in 425 ms. Offline catch-up: the app was terminated (no phone socket), Alex sent `m_TUTVSy2wyGZT` (seq 15, “offline-probe 2026-11-05 19:32:37 PKT”) with `delivered_at` null; after relaunch (PID 1543) the phone delivered it at 19:33:13 PKT (~22 s after launch, 34.5 s after send) and decrypted it once. Server DB and phone cache both had 9 unique ids for `c_kthwzfur3ztd` and zero duplicates. Typing indicators were not observed. Background APNs banners remain out of scope (unsigned `aps-environment`). Server `messages` has no body column; payloads remain nacl.box envelopes only.
8. **Hold-to-record voice note with timer + waveform** — Implemented in the chat composer. Outgoing on the physical iPhone: at 19:30:29 PKT the user sent `m_uhp2e7f3zETG` (seq 13) with `type=voice` and an `audio/m4a` attachment (`a_-UWatBfHbE9K`) that exists in the server `attachments` table and decrypted in the phone cache. As Alex, the envelope and blob decrypted to a valid M4A (ffmpeg `mov`/`aac`, 3.46 s) and receipts were marked delivered+read. Timer/waveform UI, on-screen playback in the Alex Simulator UI, and a fresh hold-to-record under observation were not separately timed. Different from a full device pass of the video’s composer chrome.
9. **Attachments menu Camera / Photos / Document / Contact, image + PDF** — Contact-card attach added in Batch 1 (reuses Sheet / Avatar / Row). Simulator this batch: “Share securely” sheet (Photo library / Camera / Document / Contact) and a sent contact card for Amelia Hart `@h200.amelia.hart0`. Photo-library attach is now device-verified: `m_lHUykMKhNxkR` / `a_5rRRRe9pxbJq` (seq 16, 20:01:41 PKT) encrypted before upload, persisted, delivered to Alex, and decrypted as a valid PNG. Camera capture, document attach, and a sent contact card from this handset were not re-tested. Server attachment encrypt/decrypt remains vitest-covered.
10. **Safety number QR + 60 digits, mark verified** — Implemented (algorithm vitest-covered; key-change clears verification). Two-device comparison not tested this batch.
11. **Incoming audio call: accept, timer, mute, speaker, end, inline “Audio call • encrypted”** — Partially implemented. WebRTC signalling, sealed SDP/ICE, mute/speaker UI, and call history exist. No CallKit / VoIP push; STUN only by default (no TURN); two-device calling has not been verified. A LAN test plan (Simulator + iPhone, TURN not required on the same Wi-Fi) is in `docs/WEBRTC_TWO_DEVICE_TEST.md`. Do not claim calls are fully end-to-end until that plan is run.
12. **Group chat (~12 members): @mentions, inline replies, photos, per-member “read by”** — Implemented in Batch 1 with minimal UI on the existing chat/Bubble (mention highlight + suggestions, long-press reply + quote, named “Read by …” from `readByUserIds`). Simulator this batch (Cast company (TEST)): `@am` mention picker for Amelia Cole, send after Retry (`@h200.amelia.cole25 half-hour noted`), and a long-press quoted reply (“Standing by — places set”). Per-member “read by” names were not separately re-tested on device. Server fan-out and `readByUserIds` remain vitest-covered.
13. **Workspace ~200 people, announcements, Acknowledge + time, 142→143/200** — Implemented and now verified on the physical iPhone for join + required ack. Isolated seed `server/scripts/seed-hamlet-200.ts` created “Hamlet UK Tour 2027 (TEST)” (`w_M2IFshcmKU84`). After a seat was freed, the phone user (`u_875nDU6SAca7` / `syed.umar`) accepted workspace invite `i_g45sG0MQc2Cg` at 19:46:09 PKT (role `member`, member count back to 200) and was assigned Stage Management (`d_fUMdmARHgRig`). Announcement `n_HHPqfNM-ft7_` “Call sheet — please acknowledge” (require-ack, 199 recipients, posted 19:46:14 PKT after they joined) was seen immediately and acknowledged at 19:47:04 PKT (DB `announcement_recipients` + API as Alex: `acked` 1 / `total` 199). They are not a recipient of the older “Half-hour call — Act I (TEST)” (`a_tnfmSDwF-u5d`), which was posted before they joined. Simulator previously showed 200 members and that older announcement at **142/200**. Announcements are **not** end-to-end encrypted.
14. **Ack breakdown tabs + Remind N + off-shift toast** — Implemented and server-verified (pending/acknowledged lists, remind, held). Simulator this batch: ack list “142 / 200 acknowledged”, 16 seen-not-yet / 42 not-seen-yet, “NOT YET ACKNOWLEDGED (58)”. The Remind button sits below the full pending list; Simulator HID scroll did not reach it, so Remind was measured via API (`reminded: 58, held: 15, deliveredNow: 43` in 20.4ms) rather than tapped in the UI.
15. **Departments (counts) + members’ local time / shift** — Implemented (directory, department filter, `localTime` / `onShift` on public users). Simulator this batch: “8 DEPARTMENTS · 200 PEOPLE” (Cast 34, Wardrobe & Wigs 42, Lighting 18, Sound 14, Set & Crew 30, Front of House 40, Stage Management 12, Production Office 10) and a member list with mixed time zones (London, Chicago, Tokyo, New York) and on/off-shift rows.
16. **Admin new announcement (title/body, all/dept, require ack, respect quiet hours)** — Implemented and server-verified.
17. **Timezone change live-updates others** — Implemented (`PATCH /me` + `user:updated`). Not re-tested live this batch.
18. **Off-shift overlay, silent counter by category, morning summary** — Implemented. Held-notification release at shift start is vitest-covered.
19. **Wrap production → read-only archive banner** — Implemented and server-verified. Wrap now also writes `audit_log`.
20. **Subscriptions / StoreKit trial Company, seats 200/200, Google Play** — Partially implemented. Plan list and client IAP UI exist. Server `POST /subscriptions/verify` now verifies an App Store Server API signed-transaction JWS (ES256 + `x5c`) against configured Apple root CA certificates (`server/src/iap.ts`, vitest with locally generated P-256 test certs). Without configured roots the endpoint stays `501 IAP_NOT_CONFIGURED`. Invalid, untrusted, mismatched, or expired JWS returns `400` and does not change `users.plan`. `{dev:true}` / `SUBSCRIPTIONS_DEV` no longer grants a trial. **Workspace create and seat caps remain enforced server-side.** Google Play is not in scope. A real sandbox purchase still needs App Store Connect products and a sandbox Apple ID (`docs/PUSH_AND_IAP_REQUIREMENTS.md`).
21. **Report from DM with chosen decrypted messages, reason, also block, chat removed** — Implemented and server-verified (report + optional block). Rate-limited this batch.
22. **Web admin: reports queue with shared messages, suspend, suspensions list, support tickets, workspace stats** — Implemented. Admin **API** (vitest-covered) plus a dedicated dashboard at `GET /admin` (plain HTML/JS from `server/admin/`, no new dependencies; `x-admin-token` or an `is_admin` user JWT). Chrome this batch, signed in as isolated `understage.ops`: Reports queue with shared evidence and the note “Everything else stays end-to-end encrypted. Admins only see what the reporter chose to share.”; Suspend 7 days / 30 days / Permanent; Suspensions list + Unsuspend; Support tickets with reply and “Send & close”; Workspaces KPIs (active / members / wrapped) and owner column; Audit log. Live `ADMIN_TOKEN` is empty so token login is disabled until that env is set. Seeded demo data did not write `audit_log` rows, so the Audit view was empty until an admin action records one.

**Video feature-parity (functional, not production-ready):** about **19 of 22 (86%)** items are implemented at the workflow level (1–4, 6–10, 12–19, 21–22 fully or with only a leftover UI gap such as Remind-scroll; 5, 11, 20 remain partial). **Device-verified 5/22 (23%) · Simulator/API/Chrome-verified 14/22 (64%) · partial/unverified vs the video 3/22 (14%).**

## Physical iPhone (2026-11-05 evening, Asia/Karachi)

Device: umer's Iphone (2), iPhone 11 Pro (iPhone12,3), iOS 26.2.1, CoreDevice `CD0482D9-0E10-5018-B0B9-200BFC370E65`, bundle `com.kvmac.understage`, Personal Team `7SH4DAD2LV`. LAN: phone `192.168.100.35` → Mac `192.168.100.91` (`:8081` Metro, `:4000` API). USB was unplugged; `system_profiler SPUSBDataType` listed no iPhone. `devicectl` stayed `connected` with `transportType: localNetwork`, `tunnelState: connected`, `tunnelTransportProtocol: tcp`.

Wireless relaunch: `devicectl device process terminate --pid 1356` then `process launch com.kvmac.understage` succeeded at 19:07:21 PKT and spawned PID 1401. After launch the phone re-established sockets to `:8081` and `:4000`. Session `s_HRuaqu9pf4Z2` (18:43:37 PKT) was reused; identity-key fingerprint unchanged; Documents contained only `SQLite/understage_u_875nDU6SAca7.db` (no secure-session file fallback).

Conversation `c_kthwzfur3ztd` (direct, created by the phone user at 18:59:09 PKT) members: `syed.umar` + `alex.rivera300`. Messages (all `kind=e2ee`):

| Time (PKT) | ID | From | Decrypted body |
| --- | --- | --- | --- |
| 18:59:15 | `m_HF6VZ3xzPd3x` | phone | Hii |
| 18:59:46 | `m_uogeWRsdosj7` | phone | Test message |
| 19:04:49 | `m_v5U71UZF7K0W` | Alex test client | Got it — encrypted reply from the Alex test client. |
| 19:08:02 | `m_26TDW0VSUT6F` | phone | How are you bro? |

Alex decrypted every envelope with the Simulator-stored secret that matches the published `identity_key` (keys were not rotated). The phone cache after relaunch stored the decrypted Alex reply. Server receipts: Alex delivered+read the three phone messages (first two at 19:04:49 PKT, follow-up at 19:11:06 PKT); the phone delivered+read the Alex reply at 19:07:38 / 19:07:43 PKT. The 19:04:49 reply was emitted on Socket.IO (`message:new` seen by the Alex client) while the phone had no ESTABLISHED `:4000` socket, so live push of that reply was not observed; the phone picked it up over HTTP after the wireless relaunch. `:4000` later dropped again, which is why a later cache copy did not yet show local tick updates for the follow-up.

Chats compose/send/receive on device: verified. Workspace: the phone user has 0 `workspace_members` rows; the Workspace UI was not observed. Settings and general tab navigation were not observed (no taps from this Mac). Runtime: Metro events after the 19:07:24 PKT relaunch were only bundling; no new device Keychain/RedBox/TypeError lines. Simulator still logs `[secure] Keychain unavailable; using sandbox file fallback for Simulator sessions` and `expo-notifications` `getRegistrationInfoAsync` entitlement errors (expected on Simulator; APNs unsigned on this Personal Team). Backend `logs/server.log` recorded OTP lines and the API listen banner only; no message plaintext.

OpenMLS directory flag remains off; the phone user has no MLS keys. IAP / APNs / CallKit / TURN / two-device calls were not part of this pass.

## Batch 2 (this update)

- Functional web admin at `/admin` + `/admin/app.js` (dark + gold, sessionStorage auth, no `@fastify/static`).
- Isolated seed `server/scripts/seed-hamlet-200.ts` (refuses `NODE_ENV=production`; idempotent teardown of only the TEST workspace / `h200.*` users / `% (TEST)` groups). Future runs also insert `identity_key` + `key_updated_at` (32 random bytes, standard base64) so encrypted group sends can succeed; recipients still cannot decrypt synthetic keys. The TEST workspace was not re-seeded after that script edit.
- DB backup before the original seed: `server/data/understage.db.bak-20261105-154151`.
- Measurements against live `:4000`: members `limit=50` 95.4ms / 17ms; `limit=100` ~25ms; acks 58 pending / 142 acknowledged in 47.2ms; remind 20.4ms (`58 / 15 held / 43 deliveredNow`); 51-member encrypted group `409 GROUP_TOO_LARGE_FOR_E2EE` in 11.7ms.
- Simulator + Chrome screenshots under `shots/` (best copies also in the box at `/workspace/uploads/sim2/`).

## Batch 1 server & client fixes


- Encrypted-group cap of 50 on create and add-members (`409 GROUP_TOO_LARGE_FOR_E2EE`).
- `serializeConv` no longer `LIMIT 50`; `members.length === memberCount`, plus `e2eeError` for oversized workspace chats.
- Sending in a non-direct conversation with more than 50 members is rejected with the same error code.
- Plan enforcement on `POST /workspaces` from `subscriptions/me` state.
- Typing events require conversation membership and are broadcast to real members (client-supplied `to` is ignored).
- `GET /users/:id` limited to self, contacts, shared conversation or workspace members, or a valid invite token.
- `POST /invites/regenerate` revokes the previous unused invite of that kind; My QR calls it. Accepting a workspace invite twice returns `alreadyMember` and does not duplicate membership (`INSERT OR IGNORE` remains).
- In-memory rate limits: search 30/min, messages 40/min, attachments 20/min, reports 8/min, invites 15/min (`429 RATE_LIMITED`).
- Workspace member search escapes `\`, `%`, and `_` (`LIKE … ESCAPE '\'`).
- `audit_log` table + writes for admin report status, suspend/unsuspend, workspace wrap, and conversation/workspace role changes; `GET /admin/audit`.
- Leaving a group calls `dropConversation` so it disappears from the local chat list immediately.
- Chat list previews hydrate decrypted bodies from the local cache (and ingest `lastMessage` when needed) after sign-in / sync, so they do not stay on “Encrypted message” until the chat is opened.
- `secure.ts` plaintext-file fallback is Simulator-only (`!Device.isDevice`) and is never used on a physical device.
- Contact-card attachment option; group @mentions, inline replies, and per-member “read by” names (minimal UI, existing components).

## Encryption (do not over-claim)

TweetNaCl X25519 + XSalsa20-Poly1305 (`nacl.box` / `nacl.secretbox`). This is **not** the Signal protocol: no forward secrecy, no ratchet, no multi-device accounts, no independent audit. Group fan-out encrypts one envelope per recipient and is capped at 50. Announcements are server-visible plaintext. Call media uses DTLS-SRTP; signalling payloads are sealed, but calling has not been verified end-to-end between two real devices. Files are encrypted on device before upload when the attach flow runs.

## t37u (2026-11-05 20:34 Asia/Karachi)

- Deep link: `shared/deep-link.ts` + `src/app/+native-intent.ts` rewrite `understage://invite/<token>` and expo-development-client URLs so expo-router always gets a navigable path (`/invite/<token>` or `/`). Already-running launch of the workspace invite URL produced `POST /invites/resolve 200` from `192.168.100.35` and no Metro `Linking did not produce an initial navigation state` / `GO_BACK`. Cold start of `expo-development-client/?url=<metro>` likewise restored the session with no linking warning. Cold start that also carried the invite produced `POST /invites/resolve 200` and no linking warning. A killed dev-client launched with only `understage://invite/…` (no Metro `url` param) starts the process but does not reconnect to Metro — Expo dev-launcher does not treat the custom invite scheme as a bundler address.
- Request logging: `server/src/http-log.ts` `onResponse` hook, dev-only, `[http] METHOD path status ip`.
- Contact invite accept returns `alreadyContact` (plus existing `INSERT OR IGNORE`) when the pair already exists; vitest covers a second accept.
- Tests this pass: `vitest run` 7 files / 51 tests passed; `npm --prefix server run typecheck` and root `npm run typecheck` passed.

## Still blocked or out of this batch

- CallKit / VoIP push, TURN, two-device calling
- APNs / Expo push delivery
- App Store IAP sandbox purchase on a device (server JWS verification is implemented and tested with local certs; no real App Store transaction has been presented)
- Physical-iPhone Settings visual confirm (Settings has no mount fetch; Calls issued `GET /calls 200` from the phone around 20:30 PKT but still needs a visual “opened without errors” confirm), camera QR scan of Alex via the in-app scanner (Chats → gold + Add contact `addbtn` → Scan QR `scanbtn` → `/scan`; My QR PNG remains on the Mac display / `logs/verify/alex-qr.png`; contact invite `i_QISQK_Ma7dUG` unused), a new voice note under observation (previous note `m_uhp2e7f3zETG` is Alex-decrypted and a valid m4a), safety-number compare, and remaining tab exploration. Workspace join + Stage Management + required ack are verified. Photo attach + Alex decrypt of a PNG in `c_kthwzfur3ztd` is verified. Warm and cold invite deep links no longer throw “Linking did not produce an initial navigation state” / GO_BACK.
- Signal-protocol migration
- SMS/email OTP provider
- Claiming that 200-person **encrypted** group messaging works (it does not; use announcements)

## Not production-ready

Single SQLite file, no backups, no HTTPS termination (use a reverse proxy), rate limits are in-memory per process, IAP/APNs/TURN/SMS are unset, encryption is not Signal, calling has not been verified between two real devices, and many video features remain Simulator/API-only.

