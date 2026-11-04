# Understage

Work chat for theatre and touring crews. It is built with React Native, Expo SDK 58 and TypeScript for iOS, and has a real Fastify + SQLite + Socket.IO backend.

```
src/            Expo Router app (screens in src/app, logic in src/lib, UI in src/components)
shared/         E2EE envelope code shared by app and server tests (tweetnacl)
server/         API + realtime server (Fastify, zod, better-sqlite3, Socket.IO, JWT)
```

> **Status: development prototype — NOT production-ready.** See "Not production-ready" in `FEATURE_MATRIX.md` and `ASSUMPTIONS.md`.

## Run it on your Mac and a real iPhone

### 1. Prerequisites
- **macOS** with **Xcode** (latest, from the App Store). Open it once and accept the licence; then `xcode-select --install`.
- **Node.js LTS** (20 or 22): `brew install node@22` or from nodejs.org. Check with `node -v`.
- **CocoaPods**: `brew install cocoapods` (or `sudo gem install cocoapods`). Check with `pod --version`.
- **Apple ID** added in Xcode → Settings → Accounts. A free account ("Personal Team") works for free provisioning; apps signed this way expire after 7 days and you must re-run the build.
- **iPhone** connected by USB (first time), unlocked, "Trust This Computer" accepted, and **Developer Mode** on: Settings → Privacy & Security → Developer Mode → On (the phone restarts). It only appears after the iPhone has been connected to Xcode once.
- The **Mac and iPhone on the same Wi-Fi** network (no guest/client-isolated Wi-Fi).

### 2. Backend (Terminal window 1)
```bash
unzip understage-app.zip && cd understage-app
npm install                          # root deps first: shared/ (used by the server) needs tweetnacl from here
cd server
npm install
cp .env.example .env                 # then edit secrets; set SEED_OWNER_PHONE to your number if you like
npm run seed                         # creates the demo company in DB_FILE (RESETS that file; SEED_RESET=0 to keep)
npm start                            # listens on 0.0.0.0:4000  → "[understage] API + realtime on :4000"
```
Check it: `curl http://localhost:4000/health`. Optional checks: `npm test` (vitest) and `npm run smoke` (needs the server running).

**Dev sign-in code (OTP):** no SMS is sent in dev. The code is printed in this terminal as `[otp] …` and is also returned to the app (`DEV_RETURN_OTP=1`).

### 3. Find your Mac's LAN IP
```bash
ipconfig getifaddr en0        # Wi-Fi; try en1 if empty
```
Check from the iPhone: open Safari on the phone and go to `http://<that-IP>:4000/health` — you should see JSON. If not, see Troubleshooting.

### 4. App (Terminal window 2, project root)
```bash
cd understage-app                    # root deps already installed in step 2
cp .env.example .env
# edit .env:  EXPO_PUBLIC_API_URL=http://<your-LAN-IP>:4000
npx expo prebuild --platform ios     # generates ios/ and runs pod install
npx expo run:ios --device            # pick your iPhone; builds, installs and starts Metro
```
- First build: if signing fails, open `ios/Understage.xcworkspace` in Xcode → target **Understage** → Signing & Capabilities → tick "Automatically manage signing", choose your Personal Team, and if needed change the bundle id (`com.understage.app`) to something unique (also update `ios.bundleIdentifier` in `app.json`). Then re-run `npx expo run:ios --device`.
- On the iPhone: Settings → General → VPN & Device Management → trust your developer certificate, then open the app.
- Allow **Local Network** access when iOS asks (needed to reach your Mac).
- Later runs: `npm start` (Metro for the dev build) and open the app; re-run `npx expo run:ios --device` after changing native config or `.env`.
- Changed `.env`? Restart Metro with `npx expo start --dev-client -c`.

### API URL resolution
`src/lib/config.ts` uses, in order: `EXPO_PUBLIC_API_URL` (`.env`) → `extra.apiUrl` (`app.config.ts`) → in dev builds, the Mac IP taken from Metro's `hostUri` + `:4000` → `http://localhost:4000` (iOS Simulator only). The Socket.IO URL is `EXPO_PUBLIC_SOCKET_URL` or the API URL.

### HTTP / App Transport Security
The dev server is plain `http`. `app.json` sets `NSAppTransportSecurity.NSAllowsLocalNetworking` (and iOS doesn't apply ATS to raw IP addresses), so `http://192.168.x.x:4000` works in development. Off your LAN, use an HTTPS tunnel instead (e.g. `npx localtunnel --port 4000` or `cloudflared tunnel --url http://localhost:4000`) and put the `https://` URL in `EXPO_PUBLIC_API_URL`. Don't ship a build that uses plain http.

### Troubleshooting
- **"Can't reach Understage (http://…)"**: wrong IP in `.env` (restart Metro with `-c` after edits), server not running, different Wi-Fi, or Local Network permission denied (Settings → Privacy & Security → Local Network → Understage).
- **macOS firewall**: System Settings → Network → Firewall → allow incoming connections for `node`.
- **Pods errors**: `cd ios && pod install --repo-update`, or `npx expo prebuild --clean`.
- **"Untrusted Developer"**: trust the certificate (see step 4). **App stops opening after 7 days**: free provisioning expired; rebuild.
- **Developer Mode missing**: connect the phone to Xcode once (Window → Devices and Simulators), then look again.
- **Port 4000 busy**: set `PORT` in `server/.env` and the same port in `EXPO_PUBLIC_API_URL`.
- **Expo Go won't work**: the app needs a development build (`react-native-webrtc`, `expo-iap`). Without WebRTC, calls are disabled with a message.
- **Calls**: need two devices with dev builds; untested on devices; without TURN they often fail across different networks.

### Checks
```bash
npx eslint src && npx tsc --noEmit && npx expo export --platform ios   # app
cd server && npx tsc --noEmit && npm test                               # server
```

### Server environment variables
See `server/.env.example` (the server loads `server/.env` if present; real environment variables win).

| Var | Purpose |
| --- | --- |
| `PORT` | Default 4000 (listens on 0.0.0.0) |
| `DB_FILE` | SQLite path (default `./understage.db`) |
| `JWT_SECRET`, `INVITE_SECRET`, `IDENTIFIER_PEPPER` | **Required in production** |
| `ACCESS_TTL_SEC`, `REFRESH_TTL_SEC` | Token lifetimes |
| `DEV_RETURN_OTP` | `0` disables returning the OTP in dev |
| `SEED_OWNER_PHONE`, `SEED_RESET` | Seed script: demo owner's phone; `0` keeps an existing DB |
| `ADMIN_TOKEN` | Enables the `/admin/*` moderation and support API (backend-only; no web admin UI) |
| `SMS_PROVIDER=twilio`, `TWILIO_SID`, `TWILIO_TOKEN`, `TWILIO_FROM` | Real SMS OTP (untested). Production refuses to boot without these |
| `EXPO_PUSH_ENABLED=1` | Send pushes through the Expo push service (needs APNs setup) |
| `TURN_URLS` (comma-sep), `TURN_USERNAME`, `TURN_CREDENTIAL` | TURN relay returned by `GET /calls/ice` |
| `SUBSCRIPTIONS_DEV=1` | Lets `/subscriptions/verify {dev:true}` start a trial without App Store validation (**dev only**) |

## Configuration for production features

- **SMS OTP:** set the Twilio vars listed above.
- **Push / APNs:**
  - Needs an Expo project id and an APNs key (Expo's push service uses EAS credentials; not set up here — EAS was not used).
  - Set `EXPO_PUSH_ENABLED=1` on the server.
  - The app registers its token with `POST /push/tokens`.
  - Off-shift recipients are *held* by the server and released when their shift starts.
- **TURN:** run coturn or use a hosted TURN service, then set `TURN_*`. Without TURN, calls between phones on different NAT'd networks will often fail. STUN only is the default.
- **In-app purchase:**
  - Create the auto-renewing subscriptions `com.understage.production.monthly` and `com.understage.company.monthly` in App Store Connect.
  - The server's `/subscriptions/verify` returns `501 IAP_NOT_CONFIGURED` until App Store Server API validation is implemented with `APPSTORE_ISSUER_ID/KEY_ID/PRIVATE_KEY`. That validation is **not implemented yet**.
  - Prices in `/subscriptions/plans` are samples.

See `ASSUMPTIONS.md` and `FEATURE_MATRIX.md`.
