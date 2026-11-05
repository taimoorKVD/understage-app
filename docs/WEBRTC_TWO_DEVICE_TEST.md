# Two-device WebRTC audio call test plan

Goal: verify a real 1:1 audio call between the iOS Simulator (Alex Rivera, `@alex.rivera300`) and the physical iPhone (Syed Umar / `syed.umar`) on the same LAN. TURN is **not** required when both devices can reach each other directly; `GET /calls/ice` already returns Google STUN (`stun:stun.l.google.com:19302`) and only appends TURN when `TURN_URLS` is set.

Do not claim calls are fully end-to-end until this plan has been run. Signalling (SDP + ICE) is sealed with `nacl.box` between the two published identity keys; media is DTLS-SRTP via `react-native-webrtc`. There is no CallKit / VoIP push on this Personal Team build, so both apps must be **foregrounded**.

## Preconditions

- Mac and iPhone on the same Wi-Fi (`192.168.100.0/24` in the current lab: Mac `192.168.100.91`, iPhone `192.168.100.35`).
- Backend `:4000` and Metro `:8081` running; both clients pointing at that backend.
- Simulator signed in as Alex; iPhone signed in as the development account. Do not rotate identity keys.
- Both devices have published `identity_key` values (already true for this pair).
- Microphone permission granted on both (Simulator: Mac microphone; iPhone: prompt on first call).
- Optional: a USB cable is **not** required; wireless `devicectl` is enough to confirm the iPhone process is alive.

## Steps

1. Confirm both clients have an ESTABLISHED TCP connection to `:4000` (`lsof -nP -iTCP:4000`).
2. On the iPhone open the **Calls** tab once (so the user has seen it) then return to the Alex chat or Contacts.
3. From the Simulator, start an outgoing audio call to Syed Umar (chat header call button or contact card). The Simulator should show “Calling…” then “Ringing…” if the phone socket is online.
4. On the iPhone, accept the incoming call banner / incoming-call UI. Grant microphone if asked.
5. Confirm:
   - Both UIs move to an active call (timer running, mute / speaker / end visible).
   - Two-way audio: speak on the iPhone, hear it on the Mac/Simulator speakers; speak on the Mac, hear it on the iPhone earpiece or speaker.
   - Mute on one side silences that track; speaker toggle on the iPhone routes to the loudspeaker.
6. End the call from one side; the other should return to idle and the server `calls` row should have `ended_at` and a duration.
7. Reverse direction: iPhone dials Alex on the Simulator; Simulator accepts; repeat the audio and hang-up checks.
8. Negative check (optional, same LAN): toggle Wi-Fi off on the iPhone for a few seconds during an active call — without TURN the call should fail or drop rather than relay. Re-enable Wi-Fi; do not treat this as a product bug until a TURN server is approved.

## Server-side verification

- `GET /calls/ice` as either user returns `turnConfigured: false` unless `TURN_URLS` is set.
- After the call, inspect the `calls` table (or the in-app call history) for `caller_id` / `callee_id`, `answered_at`, `ended_at`, `end_reason`.
- Socket events `call:invite`, `call:accept`, `call:signal`, `call:end` should appear in order. Signalling payloads are sealed envelopes (`n` + `c`), not plaintext SDP.

## Blockers (do not file as test failures)

- No CallKit or incoming call when the iPhone is locked / backgrounded (APNs / `aps-environment` unsigned).
- No TURN configured — NAT traversal beyond this LAN will fail.
- Expo Go cannot run this test (`react-native-webrtc` is native; use the existing dev build).
