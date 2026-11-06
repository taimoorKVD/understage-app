# UNDERSTAGE — COMPLETE IMPLEMENTATION AND ACHIEVEMENTS REPORT

**Document:** `UNDERSTAGE_IMPLEMENTATION_AND_ACHIEVEMENTS.md`  
**Tarikh:** 5 November 2026, Asia/Karachi (UTC+5)  
**Maqsad:** Mojuda Understage application ka current implementation report — yeh document sirf wahi cheezen byan karta hai jo aaj codebase, tests, aur verified device/API observations mein maujood hain.

Yeh report project files (`package.json` manifests, `server/`, `src/`, `shared/`, `docs/`, `FEATURE_MATRIX.md`, tests, git history) aur pehle se recorded verification results se likhi gayi hai. Koi naya build, install, ya code change is document ke liye nahi kiya gaya.

---

## 1. APPLICATION OVERVIEW

Understage theatre aur touring crews ke liye ek professional work-chat application hai. Iska kaam yeh hai ke production, company, aur tour par kaam karne wale log ek dusre se securely baat kar saken: 1:1 encrypted messages, chhote encrypted groups, workspace announcements, acknowledgements, contacts, working hours, aur ek web admin dashboard.

**Kaun use karta hai**

- **Crew members** — apna phone ya email se login karte hain, profile banate hain, contacts add karte hain, encrypted chats chalate hain, workspace join karte hain, announcements dekhte aur acknowledge karte hain.
- **Workspace owners aur admins** — workspace banate hain (plan ke mutabiq), departments manage karte hain, announcements bhejte hain, acknowledgement progress dekhte hain, members ko remind karte hain, aur production wrap kar sakte hain.
- **Platform admins** — web dashboard se reports, suspensions, support tickets, workspace stats, aur audit log dekhte hain.

**User ke nazariye se application kaise chalti hai**

User iPhone par Understage development build kholta hai. Agar pehle se session Keychain mein saved hai to app automatically wapas login ho jati hai. Warna user phone number ya email se 6-digit code verify karta hai, phir 5-step onboarding se profile, work identity, working hours, aur encryption identity set karta hai. Us ke baad Chats, Workspace, Calls, aur Settings tabs nazar aate hain. Neeche Stage Dock aur beech mein gold orb hai.

**Modules kaise mil kar kaam karte hain**

- **Mobile app** (`src/`): React Native 0.88.1, Expo SDK 58, Expo Router. Screens `src/app` mein hain, logic `src/lib` mein, UI `src/components` mein, theme `src/theme.ts` mein.
- **Shared crypto/helpers** (`shared/`): `e2ee.ts` (TweetNaCl envelopes), `outbox.ts` (offline send queue), `message-sync.ts` (dedupe/cursor), `deep-link.ts` (invite URLs).
- **Backend** (`server/`): Fastify HTTP API + Socket.IO realtime, SQLite database (`better-sqlite3`), JWT sessions, Zod validation.
- **Admin dashboard** (`server/admin/`): plain HTML/JS pages jo `GET /admin` se serve hoti hain; admin APIs `/admin/*` par hain.
- **Native encryption spike** (`modules/understage-mls`, `native/mls-poc`): OpenMLS Phase 0–2 ka implemented work; production message send abhi bhi TweetNaCl se hota hai.

**Communication flow (example)**

User Alex ko "Hii" bhejna chahta hai. Phone pehle message ko Alex ki published X25519 public key se `nacl.box` karta hai, ciphertext `POST /conversations/:id/messages` se server ko deta hai. Server plaintext nahi dekhta — woh `message_payloads` table mein sirf nonce aur ciphertext rakhta hai, phir Socket.IO event `message:new` se Alex ke phone tak envelope bhejta hai. Alex ka phone apni Keychain wali secret key se decrypt karta hai aur local SQLite cache mein decrypted body save karta hai.

Is flow ke sath hi REST endpoints profile, contacts, workspaces, announcements, attachments, subscriptions, aur admin kaam handle karte hain. Foreground realtime Socket.IO WebSocket (`transports: ['websocket']`, pingInterval 10s, pingTimeout 8s) se chalta hai. App band hone ke baad catch-up `GET /sync?since=` se hota hai.

---

## 2. LOGIN, SIGNUP & VERIFICATION

### Feature: Phone number registration and login

Yeh kya karta hai: User apna mobile number de kar account bana sakta hai ya purane account mein wapas aa sakta hai.

User kaise use karta hai: Welcome screen par "Get started" (naya account) ya "I already have an account" (sign in) dabata hai. Verify screen par Phone tab chunta hai, country code (default `+44`) aur number likhta hai, code request karta hai.

Andar system mein kya hota hai: App `POST /auth/otp/request` bhejti hai `{ kind: "phone", destination }`. Server `validateDestination` se number ko `+` ke sath 8–15 digits check karta hai (`/^\+\d{8,15}$/`). Phir `identifierHash` banata hai: `sha256(pepper + ":phone:" + normalizedNumber)`. Raw phone database mein kabhi store nahi hota — sirf yeh hash `users.identifier_hash` aur `otps.identifier_hash` mein jata hai.

Kya use hua hai: `server/src/auth.ts` (`validateDestination`, `identifierHash`), `server/src/app.ts` (`/auth/otp/request`, `/auth/otp/verify`), client `src/app/(auth)/verify.tsx`.

Kya achieve hua hai: Physical iPhone par OTP login complete hua. Returning session `s_HRuaqu9pf4Z2` (created 18:43:37 PKT, 5 November 2026, Asia/Karachi) USB unplug aur wireless relaunch ke baad bhi wahi raha; naya OTP issue nahi hua.

### Feature: Email registration and login

Yeh kya karta hai: Wahi OTP flow email se bhi available hai.

User kaise use karta hai: Verify screen par Email tab chunta hai, work email likhta hai (placeholder example: `you@theatre.co.uk`), code request karta hai.

Andar system mein kya hota hai: Server email ko trim + lowercase karta hai aur simple regex se validate karta hai. Hash `sha256(pepper + ":email:" + normalizedEmail)` hota hai. `users.identifier_kind` `email` save hota hai. Public profile mein email nahi dikhaya jata.

Kya use hua hai: Wahi auth endpoints; client kind toggle `phone | email`.

Kya achieve hua hai: Email path codebase aur server validation mein implemented hai. Is evening ke physical iPhone pass mein login phone number se verify hua.

### Feature: Verification code generation

Yeh kya karta hai: Har request par ek naya 6-digit numeric code banata hai.

User kaise use karta hai: Number/email submit karne ke baad 6 boxes nazar aate hain jahan code type kiya jata hai.

Andar system mein kya hota hai: `genOtp()` `crypto.randomInt(0, 1_000_000)` se code banata hai aur `padStart(6, "0")` karta hai. Database mein code khud nahi rukta — `code_hash = sha256(identifier_hash + code)` store hota hai. `expires_at` ab se `otpTtlSec` (600 seconds / 10 minutes) baad set hota hai. Development mein `DEV_RETURN_OTP=1` ho to response mein `devCode` bhi aa sakta hai, aur server log `[otp]` line print karta hai (destination ka pehla hissa mask hota hai). Production boot Twilio ke baghair `ConsoleOtpSender` accept nahi karta.

Kya use hua hai: Node `crypto.randomInt`, SHA-256, `ConsoleOtpSender` (dev), optional `TwilioOtpSender` (`SMS_PROVIDER=twilio`).

Kya achieve hua hai: Code generation, hashing, aur expiry server vitest auth suite mein cover hain. Physical iPhone par isi mechanism se login complete hua. Is report mein koi OTP code quote nahi kiya gaya.

### Feature: Code verification

Yeh kya karta hai: User ke 6 digits ko latest unused OTP se match karta hai aur session issue karta hai.

User kaise use karta hai: 6 digits type karta hai; 6th digit par auto-submit ho sakta hai, ya Verify button. Double-submit se bachne ke liye client `inFlight` guard rakhta hai.

Andar system mein kya hota hai: `POST /auth/otp/verify` latest unused OTP nikalta hai. Agar hash match ho jaye to OTP `used=1` ho jata hai. Agar is identifier ka user nahi mila to naya `users` row banata hai (`id` prefix `u_`) aur `isNew: true` return karta hai. Warna purana user return hota hai. Response mein `accessToken`, `refreshToken`, aur `selfUser` hota hai.

Kya use hua hai: Fastify + Zod (`code` must be `/^\d{6}$/`), JWT session issue.

Kya achieve hua hai: Verify ke baad session Keychain mein save hota hai. Agar profile already complete ho aur isi device ki identity key match kare to app seedha ready ho jati hai; warna onboarding shuru hoti hai.

### Feature: Code expiration and resend

Yeh kya karta hai: Purane code ko time ke baad band karta hai, aur naya code manga sakta hai.

User kaise use karta hai: Code screen par countdown (client 59 seconds dikhata hai) ke baad resend kar sakta hai. Expire message: "That code has expired. Request a new one."

Andar system mein kya hota hai: OTP 10 minute baad `CODE_EXPIRED` deta hai. Resend pehle us identifier ke tamam unused codes ko `used=1` kar deta hai, phir naya code insert hota hai — matlab ek waqt par sirf latest code valid hota hai. 10 minute mein 5 se zyada request `429 RATE_LIMITED` deti hai ("Too many codes requested. Try again in 10 minutes.").

Kya use hua hai: `otps` table (`expires_at`, `used`, `created_at`), `cfg.otpTtlSec = 600`.

Kya achieve hua hai: Expiry, resend-invalidates-previous, aur request rate limit implemented aur auth tests se cover hain.

### Feature: Incorrect verification codes

Yeh kya karta hai: Galat code par error deta hai aur attempts count karta hai.

User kaise use karta hai: Galat 6 digits enter kare to message aata hai: "That code is not right. Check and try again." Boxes clear ho jate hain.

Andar system mein kya hota hai: Hash mismatch par `attempts` +1 hota hai aur `400 CODE_INCORRECT` return hota hai. 5 failed attempts ke baad `429 TOO_MANY_ATTEMPTS` ("Too many attempts. Request a new code."). Active code na ho to `400 CODE_NOT_FOUND`.

Kya use hua hai: `otps.attempts` column.

Kya achieve hua hai: Brute-force ke khilaf attempt cap server par enforce hoti hai.

### Feature: Duplicate-code prevention

Yeh kya karta hai: Ek hi identifier par kai unused codes simultaneously valid na hon.

User kaise use karta hai: User ko iska alag button nahi dikhta; woh naturally latest requested code use karta hai.

Andar system mein kya hota hai: Har nayi request se pehle `UPDATE otps SET used=1 WHERE identifier_hash=? AND used=0` chalta hai. Verify hamesha latest unused row (`ORDER BY id DESC LIMIT 1`) dekhta hai.

Kya use hua hai: `server/src/app.ts` OTP request handler.

Kya achieve hua hai: Resend ke baad purana code kaam nahi karta; yeh explicitly code comment aur implementation dono mein maujood hai.

### Feature: Session creation

Yeh kya karta hai: Successful verify ke baad user ke liye login session banata hai.

User kaise use karta hai: Verify ke turant baad user app ke andar aa jata hai; usko tokens nahi dikhte.

Andar system mein kya hota hai: `issueSession` ek session id `s_...` banata hai, 32-byte refresh secret generate karta hai, aur `sessions` table mein `refresh_hash = sha256(refresh)` save karta hai. Access token JWT HS256 hai, claims `{ sub: userId, sid, typ: "access" }`. Default access TTL 900 seconds (15 minutes, `ACCESS_TTL_SEC`), refresh TTL 60 din (`REFRESH_TTL_SEC`). Refresh token format `sid.secret` hai. `POST /auth/refresh` rotate karta hai: naya secret, purana hash replace. Agar koi galat/reused refresh present kare to session revoke ho jati hai (reuse detection).

Kya use hua hai: `jsonwebtoken` HS256, `crypto.randomBytes`, `sessions` table.

Kya achieve hua hai: Session create, refresh rotate, expiry, aur revoke logic implemented hai. Physical iPhone ne session `s_HRuaqu9pf4Z2` ko relaunch ke across reuse kiya.

### Feature: Secure login storage

Yeh kya karta hai: Access/refresh tokens aur encryption identity ko phone ke secure storage mein rakhta hai.

User kaise use karta hai: User kuch extra nahi karta; app tokens khud save karti hai.

Andar system mein kya hota hai: `src/lib/secure.ts` `expo-secure-store` use karta hai, accessibility `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Session key `session` hai; identity key `identity_<userId>` hai. Physical device par Keychain fail ho to file fallback **mana** hai — error throw hota hai. Simulator (`!Device.isDevice`) par hi sandbox file `Documents/understage_secure_*.json` fallback allowed hai, kyunke unsigned Simulator builds kabhi Keychain entitlement error dete hain.

Kya use hua hai: `expo-secure-store` ~58.0.2, `expo-device` ~58.0.5.

Kya achieve hua hai: Physical iPhone 11 Pro par Keychain ne session aur X25519 identity dono persist kiye. Documents folder mein sirf local SQLite `SQLite/understage_u_875nDU6SAca7.db` thi; koi `understage_secure_*.json` file fallback nahi mili. Simulator logs ab bhi fallback warning de sakte hain — yeh expected Simulator behavior hai, physical device ka nahi.

### Feature: Automatic login after reopening the app

Yeh kya karta hai: App dubara khulne par user ko phir se OTP nahi mangti.

User kaise use karta hai: App band karta hai ya process terminate hota hai, phir Understage wapas kholta hai — Chats (ya last state) dikhai deti hai.

Andar system mein kya hota hai: `boot()` Keychain se session read karta hai, `GET /me` se profile refresh karta hai, local SQLite `understage_<userId>.db` kholta hai, identity load karta hai. Agar `profileComplete` true ho aur published `identityKey` isi device ki public key se match kare to status `ready` ho jata hai aur `startSession()` Socket.IO + sync start karta hai. 401 par local sign-out ho jata hai.

Kya use hua hai: `src/lib/engine.ts` `boot()`, `expo-secure-store`, `expo-sqlite`.

Kya achieve hua hai: 5 November 2026 ko wireless `devicectl` relaunch 19:07:21 PKT (Asia/Karachi) par session restore hua, naya OTP nahi manga gaya. Identity-key SHA-256 fingerprint `fd8f10e4997f582dda2030f9ded1fc9f7a75214fb30c6d56f4dc7986d2fccffb` terminate/relaunch ke baad bhi wahi rahi, including usi 19:07:21 PKT relaunch.

### Feature: Logout

Yeh kya karta hai: Current session band karta hai aur local credentials hataata hai.

User kaise use karta hai: Settings se sign out confirm karta hai.

Andar system mein kya hota hai: `signOut()` pehle `POST /auth/logout` bhejta hai `{ refreshToken }` — server us session ko `revoked=1` kar deta hai aur optional push token hataata hai. Phir `signOutLocal()` Keychain session clear karta hai, socket band karta hai, local DB close karta hai, Zustand store reset karta hai. Identity secret Keychain entry user id se linked rehti hai (session clear hoti hai). Suspended user verify/API par `403 SUSPENDED` dekhta hai.

Kya use hua hai: `/auth/logout`, `secure.clearSession()`, engine `signOut`.

Kya achieve hua hai: Logout path code aur session-revoke checks mein implemented hai. Is evening ke physical pass mein sign-out nahin kiya gaya, taake existing encrypted session aur data mehfooz rahe.

### Feature: Profile creation

Yeh kya karta hai: Pehli verify ke baad user ka account row banata hai, phir onboarding name/username save karti hai.

User kaise use karta hai: Naya user verify ke baad "Create your work profile" (Step 2 of 5) par display name, @username, optional role/department/avatar bhar ta hai.

Andar system mein kya hota hai: Pehli verify sirf `id`, `identifier_hash`, `identifier_kind`, `created_at` insert karti hai. Profile `PATCH /me` se complete hoti hai. `profileComplete` tab true hota hai jab `username` aur `display_name` dono maujood hon.

Kya use hua hai: `users` table, `PATCH /me`, onboarding `profile.tsx`.

Kya achieve hua hai: Physical iPhone user ka display name Syed Umar, handle `syed.umar`, `profileComplete` true, timezone `Asia/Karachi`. Role/department/avatar us pass mein khali chhoray gaye.

### Feature: Returning-user authentication

Yeh kya karta hai: Purane user ko wahi hashed identifier se pehchanta hai aur naya duplicate account nahi banata.

User kaise use karta hai: Wahi phone/email se dubara code verify karta hai. Agar profile aur keys pehle se complete hain to seedha app khulti hai.

Andar system mein kya hota hai: Verify `users` ko `identifier_hash` se dhoondhta hai. Mil jaye to `isNew: false` ke sath session milti hai. Client check karta hai: `profileComplete && identity && identity.publicKey === user.identityKey` — true ho to `finishOnboarding()`, warna onboarding resume hoti hai.

Kya use hua hai: `identifier_hash` uniqueness, client `verify.tsx` + `boot()`.

Kya achieve hua hai: Returning session restore physical iPhone par verified hai (same session id, no new OTP).

---

## 3. COMPLETE ONBOARDING

Onboarding 5 steps mein hai (video ke 4 steps se alag count). `src/app/(onb)/index.tsx` decide karta hai: agar `profileComplete` ho to seedha `/keys`, warna `/profile`.

### Feature: Phone/email verification (Step 1 of 5)

Yeh kya karta hai: Onboarding ka pehla darwaza — yeh confirm karta hai ke number ya email isi user ke paas hai.

User kaise use karta hai: "Get started" par Step 1 "Verify your account" khulta hai. Phone/email choose karke code verify karta hai. Screen clearly kehti hai: identifier "Used for verification only. Never visible to other users."

Andar system mein kya hota hai: Section 2 wala OTP flow. Successful verify ke baad tokens Keychain mein save hote hain aur `me` store mein aa jata hai.

Kya use hua hai: `(auth)/verify.tsx`, `/auth/otp/*`.

Kya achieve hua hai: Physical iPhone par Step 1 complete ho chuka hai; session persist bhi verified hai.

### Feature: Profile and username (Step 2 of 5)

Yeh kya karta hai: Work display name aur unique @username set karta hai.

User kaise use karta hai: "Create your work profile" par name (example placeholder "Sophie Marlowe"), username (3–24 characters: letters, numbers, dot, underscore), optional role, department, aur avatar bharta hai. Username type karte hi availability check hoti hai — "@name is available" ya "taken".

Andar system mein kya hota hai: Debounced `GET /users/check-username` uniqueness dekhta hai (`username` UNIQUE COLLATE NOCASE). Save `PATCH /me` se hota hai. Duplicate par server `409 USERNAME_TAKEN` deta hai. Validation regex `^[a-z0-9._]{3,24}$`. Avatar field server par max 400,000 characters allow karta hai.

Kya use hua hai: `profile.tsx`, `PATCH /me`, `GET /users/check-username`.

Kya achieve hua hai: Device par profile save hui — Syed Umar / `syed.umar`. Username uniqueness server vitest mein cover hai.

### Feature: Work identity (Step 3 of 5)

Yeh kya karta hai: User ko batata hai ke colleagues kya dekh sakte hain aur kya kabhi nahi dekhenge.

User kaise use karta hai: "Your work identity" screen par apna work card dekhta hai (name, @username, optional role, WORK pill) aur visibility list:

- Work name & role — Visible
- Working-hours status — Visible
- Phone number / email — Never
- Personal contacts — Never
- Location — Never

Andar system mein kya hota hai: Yeh informational step hai; koi extra API call nahi. Visibility asal mein `publicUser()` se enforce hoti hai: public payload mein `id`, name, username, role, department, avatar, identity public key, timezone, `localTime`, `onShift`, shift window aate hain. Phone/email raw value kabhi public JSON mein nahi jati. `GET /users/:id` sirf tab milta hai jab viewer khud ho, contact ho, shared conversation/workspace member ho, ya valid invite token ho.

Kya use hua hai: `src/app/(onb)/identity.tsx`, `publicUser()` in `server/src/app.ts`.

Kya achieve hua hai: Screen aur server-side field filtering implemented hain. Visibility list is device batch mein separately re-test nahi hui; profile data device par save ho chuka hai.

### Feature: Working hours (Step 4 of 5)

Yeh kya karta hai: User ke kaam ke din, shift start/end, timezone follow, touring mode, aur quiet hours set karta hai.

User kaise use karta hai: "Working hours" screen par work days (Mon=0 .. Sun=6), shift start/end (`HH:MM`), aur related toggles choose karta hai. Kam az kam ek work day chahiye. Continue `PATCH /me` bhejta hai.

Andar system mein kya hota hai: Defaults: timezone `Europe/London`, `follow_phone_tz=1`, `touring_mode=0`, `quiet_hours=1`, `work_days='[0,1,2,3,4,5]'` (Mon–Sat), `shift_start='12:00'`, `shift_end='23:30'`. Timezone IANA string honi chahiye (`Intl.DateTimeFormat` se validate). Physical iPhone user ki timezone `Asia/Karachi` save hui.

Kya use hua hai: `(onb)/hours.tsx`, later editable `hours-settings.tsx`, `src/lib/time.ts`, server `isOnShift`.

Kya achieve hua hai: Hours fields save aur `isOnShift` calculation vitest se verified hain (day, overnight shifts, time zones).

### Feature: Encryption identity setup (Step 5 of 5)

Yeh kya karta hai: Is phone par X25519 identity key pair banata hai, public half server par publish karta hai, secret half Keychain mein save karta hai.

User kaise use karta hai: "Securing your account" screen teen steps dikhati hai: "Creating identity key on this phone", "Publishing your public key", "Saving secret key to iOS Keychain". Complete hone par "Your messages are end-to-end encrypted" aur "Start messaging" button aata hai.

Andar system mein kya hota hai: `ensureKeys()` pehle Keychain mein existing identity dhoondhta hai; na ho to `generateIdentity()` (`nacl.box.keyPair()`) se naya pair banata hai. Random bytes `expo-crypto` (iOS par `SecRandomCopyBytes`) se aate hain. Public key `PUT /me/keys` se jati hai (base64 X25519, regex `^[A-Za-z0-9+/]{43}=$`). Agar pehle se key thi aur naya public key alag hai to contacts ki `verified` flag clear ho jati hai aur `keys:changed` emit hota hai. Secret key sirf device par rehti hai. `MLS_DIRECTORY_ENABLED` / `EXPO_PUBLIC_MLS_DIRECTORY` default off hain, is liye yeh step KeyPackages publish nahi karta — sirf TweetNaCl identity.

Kya use hua hai: `src/lib/engine.ts` `ensureKeys`, `shared/e2ee.ts`, `expo-crypto`, `expo-secure-store`, `PUT /me/keys`.

Kya achieve hua hai: Physical iPhone par identity Keychain mein bani, publish hui, sandbox file fallback nahi use hua, aur fingerprint relaunch ke baad unchanged rahi. Yeh Signal-style one-time prekeys nahi hain, aur Secure Enclave key generation nahi hai — Keychain storage hai.

---

## 4. END-TO-END ENCRYPTION

End-to-end encryption ka seedha matlab yeh hai: jo text, photo, document, ya voice note aap bhejte hain, uska plaintext sirf sender aur intended recipients ke devices par khulta hai. Understage server raaste mein hai, lekin woh ciphertext store karta hai — `messages` table mein body column hi nahi hai.

**Emaan-dari ki line:** Current production encryption TweetNaCl static-key "sealed per recipient" model hai. Yeh Signal protocol nahi hai: koi double ratchet nahi, koi forward secrecy nahi, koi multi-device account nahi. Groups mein har member ke liye alag `nacl.box` banta hai (fan-out), sender keys nahi.

### Feature: Private message encryption

Yeh kya karta hai: Har message ko har recipient (aur sender ki apni copy) ke liye alag sealed envelope banata hai.

User kaise use karta hai: Chat mein type karke send dabata hai. UI lock icon se encrypted conversation indicate karti hai.

Andar system mein kya hota hai: Plain object `{ v: 1, type: "text", text, sentAt, replyTo?, mentions? }` JSON banta hai. `encryptForRecipients` har recipient ki public key se `nacl.box` (X25519 key agreement + XSalsa20-Poly1305) chalata hai. Server ko `{ clientId, payloads: [{ recipientId, nonce, ciphertext }] }` milta hai. Server check karta hai ke har member ke liye envelope maujood ho (`MISSING_RECIPIENTS` warna). Direct chat mein block ho to `403 BLOCKED`.

Kya use hua hai: `tweetnacl` 1.0.3, `tweetnacl-util` 0.15.1, `shared/e2ee.ts`.

Kya achieve hua hai: Physical iPhone ↔ Alex (`@alex.rivera300`, conversation `c_kthwzfur3ztd`) par encrypted messages decrypt hue: "Hii", "Test message", "How are you bro?", Alex ka reply, user ka "Ohh ok". Server `messages` table mein plaintext nahi tha — sirf `kind=e2ee` envelopes.

### Feature: Encryption key generation

Yeh kya karta hai: Har device par ek X25519 identity key pair banata hai.

User kaise use karta hai: Onboarding Step 5 automatically yeh karti hai.

Andar system mein kya hota hai: `nacl.box.keyPair()`. Public 32 bytes base64; secret 32 bytes base64. App tweetnacl ko `expo-crypto.getRandomBytes` se CSPRNG deti hai.

Kya use hua hai: TweetNaCl, expo-crypto.

Kya achieve hua hai: Device par key generate aur publish hui; fingerprint relaunch par same rahi. One-time prekey bundles maujood nahi hain.

### Feature: Private key storage and Keychain integration

Yeh kya karta hai: Secret key ko iOS Keychain mein rakhta hai taake app restart ke baad bhi decrypt ho sake.

User kaise use karta hai: User key files nahi dekhta. App khud Keychain use karti hai.

Andar system mein kya hota hai: `secure.setIdentity(userId, { publicKey, secretKey })`. Accessibility `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. Physical device file fallback refuse karti hai. Local message cache alag SQLite file mein decrypted bodies rakhati hai (iOS Data Protection); secret key us file mein nahi hoti.

Kya use hua hai: `expo-secure-store`, `src/lib/secure.ts`, `src/lib/db.ts`.

Kya achieve hua hai: Physical iPhone par Keychain path verified. Simulator par product Keychain kabhi fallback use karta hai. OpenMLS Phase 1 self-test (unsigned Simulator, `CODE_SIGNING_ALLOWED=NO`) pehle Keychain status `-34018` (`errSecMissingEntitlement`) par fail hua; wrapping key ne us error par Application Support file-protection fallback use kiya, us ke baad MLS self-test PASS hua. Signed device builds MLS wrapping key ke liye Keychain first try karti hain. Product identity ka physical-device test file fallback ke baghair pass hua.

### Feature: Message send flow (device se server tak)

Yeh kya karta hai: Type karne se lekar server acknowledgement tak poora path.

User kaise use karta hai: Send dabata hai; bubble pehle `pending` dikhai deti hai, phir `sent` / `delivered` / `read`.

Andar system mein kya hota hai:
1. `send()` ek `clientId` (`expo-crypto` UUID) banata hai aur outbox mein item rakhta hai.
2. Local cache optimistic row insert karti hai (`status: pending`).
3. Online hone par `outbox.flush` `sendItem` chalta hai.
4. Conversation members ki public keys se envelopes bante hain.
5. `POST /conversations/:id/messages` — server `UNIQUE (sender_id, client_id)` se duplicate retry ko pehli message wapas kar deta hai (`duplicate: true`).
6. Server `message_payloads` insert karta hai, receipts rows (recipients ke liye) banata hai, `last_seq` barhata hai, `message:new` emit karta hai.
7. Client server id se local row replace karta hai.

Kya use hua hai: `shared/outbox.ts` (max 6 attempts, exponential backoff), `src/lib/engine.ts`, Fastify messages route.

Kya achieve hua hai: Send/receive physical iPhone par verified. Outbox logic alag vitest file se cover hai.

### Feature: Server kya store karta hai

Yeh kya karta hai: Server routing aur delivery ke liye metadata + ciphertext rakhta hai, plaintext nahi.

User kaise use karta hai: User ko yeh directly nazar nahi aata; safety is par based hai ke server message padh nahi sakta.

Andar system mein kya hota hai: `messages` = `seq`, `id`, `conversation_id`, `sender_id`, `client_id`, `kind`, `created_at`. `message_payloads` = `message_id`, `recipient_id`, `nonce`, `ciphertext`. Attachments table encrypted blob rakhti hai (client ne pehle `nacl.secretbox` kiya hota hai). Metadata server ko nazar aati hai: kaun kisi se baat kar raha hai, kab, group membership. Announcements alag hain — woh server-visible plaintext hain (section 10).

Kya use hua hai: SQLite schema in `server/src/db.ts`.

Kya achieve hua hai: Live conversation check mein server-side ciphertext-only storage confirm hui; backend log mein message plaintext nahi thi.

### Feature: Recipient decryption

Yeh kya karta hai: Receiver apni secret key aur sender ki public key se envelope kholta hai.

User kaise use karta hai: Chat kholta hai; readable text/photo/voice dikhai deta hai.

Andar system mein kya hota hai: `ingest()` `decryptPayload(nonce, ciphertext, senderPublicKey, mySecretKey)` chalta hai (`nacl.box.open`). Fail ho to sender key refresh karke ek baar phir try. Decrypt ke baad incoming messages ke liye `POST /messages/delivered` chalta hai. Preview list local cache se decrypted body dikhati hai, taake list par "Encrypted message" na atka rahe.

Kya use hua hai: `decryptPayload`, local `expo-sqlite` cache, `hydrateConversationPreviews`.

Kya achieve hua hai: Alex ne phone ke tamam envelopes decrypt kiye (keys rotate nahi hui thin). Phone ne Alex ke replies decrypt karke cache kiye, including offline-probe `m_TUTVSy2wyGZT` relaunch ke baad.

### Feature: Safety numbers

Yeh kya karta hai: Do log compare kar ke dekh sakte hain ke un ke beech wahi identity keys hain.

User kaise use karta hai: Contact/chat se safety screen kholta hai. 60 digits, 12 groups of 5, dono phones par identical order (user ids sort karke). QR bhi generate/compare ho sakti hai, aur user "mark verified" kar sakta hai.

Andar system mein kya hota hai: `safetyNumber()` `nacl.hash` ko 5200 rounds `understage-safety-v1:` prefix ke sath chalta hai. Agar dono sides ke paas MLS signature public keys hon to `mlsSafetyNumber` (`understage-mls-safety-v1:`) prefer hota hai; warna TweetNaCl number. Key change par `contacts.verified=0` ho jata hai.

Kya use hua hai: `shared/e2ee.ts`, `src/app/(app)/safety/[id].tsx`, `POST /contacts/:id/verify`.

Kya achieve hua hai: Algorithm vitest mein cover hai ("attachments are encrypted blobs; safety numbers match on both sides"). Do physical devices par side-by-side compare is batch mein nahi chala.

### Feature: Identity verification

Yeh kya karta hai: Safety number check ke baad contact ko verified mark karta hai.

User kaise use karta hai: Safety screen se verify action.

Andar system mein kya hota hai: `POST /contacts/:id/verify` contact row ki `verified` flag set karta hai. Published identity key change hone par yeh flag reset hoti hai aur `keys:changed` realtime event jati hai.

Kya use hua hai: `contacts.verified`, `PUT /me/keys` side-effect.

Kya achieve hua hai: Server-side reset-on-key-change implemented aur documented hai.

### Feature: Encrypted photos, documents, and voice notes

Yeh kya karta hai: Files ko device par encrypt karke upload karta hai, recipients unhe decrypt karke kholte hain.

User kaise use karta hai: Chat composer se Photo library / Camera / Document / Contact / hold-to-record voice. Recipient bubble se dekh ya play karta hai.

Andar system mein kya hota hai: File bytes `encryptBlob` se `nacl.secretbox` hote hain (random 32-byte key + nonce). Ciphertext `POST /attachments` par BLOB save hota hai (25 MB limit, rate 20/min). Attachment key/nonce message envelope ke andar jate hain, alag se server ko nahi bataye jate. Receiver `GET /attachments/:id` se blob lata hai aur `decryptBlob` karta hai, phir cache file likhta hai. Voice payload `{ type: "voice", attachment, durationSec, waveform }`; image `{ type: "image", attachment, caption?, width?, height? }`; doc `{ type: "doc", attachment }`.

Kya use hua hai: TweetNaCl secretbox, `expo-file-system`, `expo-image-picker`, `expo-document-picker`, `expo-audio`, `expo-camera`.

Kya achieve hua hai:
- Photo: 20:01:41 PKT, message `m_lHUykMKhNxkR` (seq 16), attachment `a_5rRRRe9pxbJq` (`image/png`, valid PNG magic). Alex ne decrypt kiya (`validImage: true`).
- Voice: 19:30:29 PKT, message `m_uhp2e7f3zETG` (seq 13), attachment `a_-UWatBfHbE9K` (`audio/m4a`). Alex side par decrypt karke valid M4A mili (`ftyp:M4A`, ffmpeg `mov`/`aac`, 3.46 seconds), receipts delivered+read.
- Document/camera-capture/contact-card device se is evening separately re-test nahi hue; contact-card Simulator par pehle bheja ja chuka tha (Amelia Hart). Attachment encrypt/decrypt vitest-covered hai.

### Feature: Encrypted group messaging (current active path)

Yeh kya karta hai: Group ke har member ke liye alag envelope bana kar message bhejta hai.

User kaise use karta hai: Group chat mein type/send; 50 se zyada members par composer notice / server error aata hai.

Andar system mein kya hota hai: `E2EE_GROUP_LIMIT = 50`. Create, add-members, aur send teeno jagah `409 GROUP_TOO_LARGE_FOR_E2EE`. Workspace company chat 200 members tak ho sakti hai lekin us size par E2EE nahi: `serializeConv` poori member list deta hai (purani `LIMIT 50` truncation hata di gayi) aur `e2eeError: "GROUP_TOO_LARGE_FOR_E2EE"` set karta hai. App composer notice dikhati hai ke announcements use hon.

Kya use hua hai: Per-recipient `nacl.box` fan-out, server cap.

Kya achieve hua hai: 51-member encrypted group reject `409` 11.7ms mein measure hua. Group fan-out, roles, admin-only management vitest mein pass hue. 200-person **encrypted** group chat active nahi hai — us size par announcements use hoti hain.

### Feature: OpenMLS Phase 0 — toolchain compile gate

Yeh kya karta hai: OpenMLS 0.9 ko Mac host aur iOS targets par compile karke prove kiya ke library is machine par build ho sakti hai.

User kaise use karta hai: Yeh product UI nahi hai. Throwaway crate `native/mls-poc` thi; Understage app/server Phase 0 mein change nahi hue.

Andar system mein kya hota hai: rustup 1.29.3, rustc/cargo 1.99.1, targets `x86_64-apple-ios` + `aarch64-apple-ios`. Host test `alice_bob_charlie_roundtrip_and_reload` pass: Alice/Bob credentials, Welcome join, dono taraf application messages, Charlie add/remove (removed member later message decrypt nahi kar saka), sqlite persist + reload. Ciphersuite `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519`. iOS static libs ~32.3 MiB (sim) aur ~32.7 MiB (device). UniFFI 0.32.2 Swift typecheck pass.

Kya use hua hai: OpenMLS 0.9.2, openmls_rust_crypto 0.6.0, openmls_sqlite_storage 0.3.0, rusqlite bundled, Xcode 26.3.

Kya achieve hua hai: Phase 0 compile gate 5 November 2026 (Asia/Karachi) par complete. Is ne OpenMLS ko product send path mein nahi lagaya.

### Feature: OpenMLS Phase 1 — native Expo module + self-test

Yeh kya karta hai: OpenMLS ko UniFFI ke through Expo module `understage-mls` mein wrap karta hai, existing SDK 58 / RN 0.88.1 iOS target se link karke.

User kaise use karta hai: Hidden `__DEV__` route `understage://mls-selftest`. Production chats is module se message nahi bhejti.

Andar system mein kya hota hai: `MlsSession` storage, credential, KeyPackage export, group create/add/join, encrypt/decrypt, remove, epoch read. Group state sqlite; identity/signer sealed vault AES-256-GCM. Host cargo test `alice_bob_welcome_encrypt_decrypt_remove` pass (0.25s). XCFramework ~75 MB. `xcodebuild` final `BUILD_EXIT 0` 16:55:15 PKT. App Debug-iphonesimulator size 178 MB. Simulator (iPhone 17 Pro) par self-test **PASS**: `MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519 · epoch 1 · Alice ↔ Bob application messages`. Unsigned Simulator Keychain `-34018` ke baad wrapping-key file fallback; us ke baad PASS.

Kya use hua hai: `modules/understage-mls` (OpenMLS 0.9.2 + UniFFI 0.32.2), `src/lib/mls.ts`, `src/app/mls-selftest.tsx`.

Kya achieve hua hai: Phase 1 native spike linked aur Simulator self-test PASS. Production `src/lib/crypto.ts` / nacl send path is phase se change nahi hua.

### Feature: OpenMLS Phase 2 — AS/DS directory (implemented, default off)

Yeh kya karta hai: Authentication Service / Delivery Service HTTP directory: credentials, KeyPackages, commits, welcomes. Server opaque bytes store karta hai; plaintext, epoch secrets, ya signature private keys nahi dekhta.

User kaise use karta hai: Default configuration mein user ko kuch alag nahi dikhta, kyunke flag off hai. Flag on ho to `ensureKeys` KeyPackages publish kar sakta hai.

Andar system mein kya hota hai: Server flag `MLS_DIRECTORY_ENABLED=1`; client `EXPO_PUBLIC_MLS_DIRECTORY=1`. Default dono off. Off hone par MLS routes `404 MLS_DISABLED` deti hain, `publicUser` extra MLS fields nahi jorta, `GET /health` `mlsDirectory: false` deta hai. Schema: `users.mls_signature_key` / `mls_credential_identity` / `mls_key_updated_at`; tables `mls_key_packages`, `mls_groups`, `mls_messages`, `mls_welcomes`. Endpoints: `PUT /me/mls/credential`, `POST /me/key-packages`, `GET /me/key-packages/status`, `GET /users/:id/key-package` (ordinary single-use, last-resort reuse), `POST /conversations/:id/mls/commits` (epoch transaction, `409 EPOCH_CONFLICT`), `GET /conversations/:id/mls`. Native UniFFI abhi signature public key export nahi karta, is liye production client apni real OpenMLS credential key publish nahi karta; server endpoint tests ke liye maujood hai. Production send/receive ab bhi TweetNaCl hai — Phase 2 ne send path par MLS groups create nahi kiye.

Kya use hua hai: `server/src/mls.ts`, `server/test/mls-directory.test.ts` (9 cases), client publish hook `src/lib/mls.ts`.

Kya achieve hua hai: Phase 2 directory code landed, tests un 9 directory cases ko cover karte hain, typecheck us phase par exit 0 tha. Live health flag off hai. Yeh active production messenger encryption nahi hai; yeh completed, flag-gated directory implementation hai.

---

## 5. CONTACTS & INVITATIONS

### Feature: Adding someone through a username

Yeh kya karta hai: @username se doosre Understage user ko contact banata hai aur direct chat kholta hai.

User kaise use karta hai: Chats par + / Add contact, username search karta hai (kam az kam 2 characters), result se add karta hai.

Andar system mein kya hota hai: `GET /users/search?q=` username ya display name par LIKE search (leading match, 20 results, khud ko aur blocked users ko exclude). `POST /contacts` contact row insert karta hai (`INSERT` semantics; duplicate pair `alreadyContact` / `INSERT OR IGNORE`). Us ke baad client `openDirect` se `POST /conversations { kind: "direct", userId }` karta hai — agar pehle se direct chat ho to wahi conversation wapas milti hai.

Kya use hua hai: `/users/search` (rate limit 30/min), `/contacts`, `/conversations`.

Kya achieve hua hai: Physical iPhone user ne `@alex.rivera300` add karke direct chat `c_kthwzfur3ztd` khola (created 18:59:09 PKT). Username add device-verified hai.

### Feature: Contact search

Yeh kya karta hai: Registered users ko @handle ya name se dhoondhta hai.

User kaise use karta hai: Add screen ke search field mein type karta hai.

Andar system mein kya hota hai: Query lowercase, leading `@` hata, `%` `_` strip, phir `username LIKE q%` ya display_name LIKE. Results `publicUser` + `isContact` flag ke sath aate hain. Phone numbers search mein nahi aate.

Kya use hua hai: SQLite LIKE, in-memory rate limit bucket.

Kya achieve hua hai: Search physical iPhone par Alex ko find karne ke liye kaam ki.

### Feature: QR code creation

Yeh kya karta hai: User ka contact invite QR banata hai jo doosra insaan scan kar sake.

User kaise use karta hai: "My QR" screen kholta hai. App invite token se QR draw karti hai.

Andar system mein kya hota hai: `POST /invites` kind `contact` (ya workspace). `POST /invites/regenerate` pehle unused invite of that kind ko revoke karta hai, phir naya token banata hai — My QR yahi call karti hai. QR payload `understage://invite/<token>` format follow karti hai.

Kya use hua hai: `react-native-qrcode-svg` 6.3.52, `react-native-svg` 15.16.0, `server/src/invites.ts`, `src/app/(app)/myqr.tsx`.

Kya achieve hua hai: Simulator par Alex ke account se My QR 19:54:28 PKT khuli, contact invite `i_QISQK_Ma7dUG` mint hui, pehle unused Alex contact invites revoke huin. Screenshot Mac par save hua. Server invite/QR cases vitest-covered hain; regenerate-revokes-previous wired aur tested hai.

### Feature: QR scanning

Yeh kya karta hai: Camera se doosre user ka QR padh kar invite resolve/accept karta hai.

User kaise use karta hai: Add contact → Scan QR, ya Stage Dock orb se Scan QR. Camera permission prompt (`NSCameraUsageDescription`).

Andar system mein kya hota hai: `src/app/(app)/scan.tsx` `expo-camera` se scan karta hai. Token `tokenFromInviteUrl` / `normalizeUnderstageDeepLink` se nikalta hai, phir `POST /invites/resolve` aur `POST /invites/accept`. Deep link `understage://invite/<token>` aur expo-development-client URL rewrite `shared/deep-link.ts` + `src/app/+native-intent.ts` se `/invite/<token>` ban jati hai.

Kya use hua hai: `expo-camera` ~58.0.14, deep-link helpers.

Kya achieve hua hai: Scanner code, token parsing tests, aur deep-link rewrite verified (invite URL se `POST /invites/resolve 200`, linking warning/GO_BACK nahi). Physical iPhone camera se Alex ka QR scan is evening exercise nahi hua — username add alag se verified hai.

### Feature: Invitation links

Yeh kya karta hai: Contact ya workspace join ke liye shareable link/token deta hai.

User kaise use karta hai: Link kholta hai (`/invite/<token>` screen) aur Accept dabata hai.

Andar system mein kya hota hai: Invites table: `id`, `kind`, `user_id`, `workspace_id`, `expires_at`, `revoked`. Resolve user/workspace summary return karta hai (member count ke sath), bina raw phone ke. Expired, revoked, tampered, ya self invite reject hote hain. Workspace accept seat limit check karta hai (`WORKSPACE_FULL`).

Kya use hua hai: `/invites`, `/invites/resolve`, `/invites/accept`, invite deep links.

Kya achieve hua hai: Vitest "valid, tampered, expired, self, and workspace invites" pass. Physical iPhone ne workspace invite `i_g45sG0MQc2Cg` 19:46:09 PKT accept ki.

### Feature: Adding contacts and duplicate handling

Yeh kya karta hai: Contact list maintain karta hai aur dobara accept par duplicate row nahi banata.

User kaise use karta hai: Username, QR, ya invite se add. Agar pehle se contact ho to app already-contact treat karti hai.

Andar system mein kya hota hai: `contacts` primary key `(owner_id, contact_id)`. Accept par `alreadyContact` flag + `INSERT OR IGNORE`. Workspace accept par `alreadyMember` — dobara membership duplicate nahi hoti.

Kya use hua hai: SQLite composite PK, accept handlers.

Kya achieve hua hai: Contact-accept idempotency vitest cover; workspace accept idempotent test bhi pass.

### Feature: Contact profiles

Yeh kya karta hai: Doosre user ka public work profile dikhata hai.

User kaise use karta hai: Contact ya chat header se profile dekhta hai: name, @username, role, department, avatar, local time, on/off shift, verified/blocked flags.

Andar system mein kya hota hai: `GET /users/:id` visibility rules ke sath `publicUser` return karta hai. Viewer ko phone/email nahi milta.

Kya use hua hai: `publicUser()`, user route guard.

Kya achieve hua hai: Profile fields device chats (Alex Rivera) mein use hue. Visibility guard vitest: "GET /users/:id is limited to contacts, shared chats/workspaces, or a valid invite".

### Feature: Phone number privacy

Yeh kya karta hai: Phone/email ko verification identifier ki tarah rakhta hai, social graph ki tarah nahi.

User kaise use karta hai: Onboarding identity screen "Never" dikhati hai. Verify screen bhi "Never visible" likhti hai.

Andar system mein kya hota hai: DB comment: "Raw phone is never stored." Sirf `identifier_hash`. `publicUser` / search results / contact lists mein destination field nahi. `selfUser` sirf `identifierKind` (`phone` ya `email`) khud user ko batata hai, number nahi.

Kya use hua hai: `IDENTIFIER_PEPPER` + SHA-256 hashing.

Kya achieve hua hai: Privacy model schema, API serialization, aur onboarding copy teeno jagah consistent hai.

---

## 6. INDIVIDUAL MESSAGING

### Feature: Starting a conversation

Yeh kya karta hai: Do users ke beech unique direct conversation banata hai.

User kaise use karta hai: Contact add karke chat kholta hai, ya existing row par tap karta hai.

Andar system mein kya hota hai: `POST /conversations { kind: "direct", userId }` existing pair dhoondhta hai; na ho to naya `c_...` banata hai aur dono ko `conversation_members` mein dalta hai.

Kya use hua hai: conversations + conversation_members tables.

Kya achieve hua hai: `c_kthwzfur3ztd` phone user aur `alex.rivera300` ke beech create hui aur usi mein saari verified 1:1 traffic chali.

### Feature: Sending and receiving messages

Yeh kya karta hai: Encrypted text (aur media) ek side se doosri side pahunchata hai.

User kaise use karta hai: Composer mein type karta hai, send karta hai; doosri side bubble dikhti hai.

Andar system mein kya hota hai: Section 4 ka encrypt → POST → payload store → `message:new` → decrypt → cache. Client `clientId` se apni pending row ko server id se merge karta hai.

Kya use hua hai: engine `send` / `ingest`, Fastify messages route.

Kya achieve hua hai: Device-verified messages (PKT, Asia/Karachi): `m_HF6VZ3xzPd3x` "Hii"; `m_uogeWRsdosj7` "Test message"; `m_v5U71UZF7K0W` Alex reply; `m_26TDW0VSUT6F` "How are you bro?"; `m_gOOscrUmjH6I` "Ohh ok"; plus later probes, voice, photo.

### Feature: Real-time WebSocket communication and instant delivery

Yeh kya karta hai: App foreground mein hone par naya message turant screen par lata hai, polling ke baghair.

User kaise use karta hai: Chat khuli rakhta hai; doosri side ka message seconds ke andaar dikhai deta hai.

Andar system mein kya hota hai: Server `socket.io` pingInterval 10,000 ms, pingTimeout 8,000 ms. Client `transports: ['websocket']`, `upgrade: false`, auth callback se current access token, infinite reconnect, 12s `ensureSocket` watchdog. App foreground (`AppState`) ya network wapas (`@react-native-community/netinfo`) par `wakeRealtime()` socket + `refreshAll()` chalta hai. Socket `UNAUTHORIZED` par `/me` se token refresh trigger hota hai.

Kya use hua hai: `socket.io` 4.8.4 server, `socket.io-client` 4.8.4 app, `src/lib/engine.ts` `connectSocket`.

Kya achieve hua hai: Live foreground: Alex ne `m__tqbargVhgt5` ("realtime-probe 2026-11-05 19:28:26 PKT") bheja jab phone ka `:4000` socket ESTABLISHED tha aur chat khuli thi; phone ki `delivered_at` **149 ms** baad thi; user ne padh kar "Ohh ok" reply ki. Reconnect: listener interrupt ke baad 19:31:59 PKT restore; Alex ka `m_RbEPEbbOZ4jl` (seq 14) **425 ms** mein delivered+read hua.

### Feature: Sent, delivered and read receipts

Yeh kya karta hai: Sender ko batata hai ke message server tak gaya, doosre device ne receive kiya, aur padha gaya.

User kaise use karta hai: Bubble ke paas ticks / status dekhta hai (sent → delivered → read). Groups mein named "Read by …" `readByUserIds` se ban sakta hai.

Andar system mein kya hota hai: Recipient ingest par `POST /messages/delivered`. Chat open/read par `POST /conversations/:id/read { seq }` — yeh us seq tak ke unread receipts `read_at` set karta hai (aur `delivered_at` bhi coalesce karta hai). Server sender ko `message:status` emit karta hai. Client `applyMessageStatus` live list ya local cache par apply karta hai. `/sync` receipt-only updates se seq nahi barhata, is liye reconnect ke baad `syncOutgoingReceipts()` loaded conversations ki history refetch karta hai.

Kya use hua hai: `receipts` table, `message:status` event, `shared/message-sync.ts`.

Kya achieve hua hai: Live ticks: Alex ne seq 12 ko 19:30:03 PKT delivered+read mark kiya; 19:30:09 PKT cache copy `status=read` / `read_by=1` thi, bina relaunch ke, duplicate ids ke baghair. Offline catch-up: app terminate, Alex ne `m_TUTVSy2wyGZT` (seq 15) bheja (`delivered_at` null); relaunch PID 1543 ke baad phone ne 19:33:13 PKT deliver kiya (~22 s after launch, 34.5 s after send) aur ek dafa decrypt kiya. Server DB aur phone cache dono mein us conversation ke 9 unique ids, zero duplicates.

### Feature: Typing indicators

Yeh kya karta hai: Doosre member ko batata hai ke koi type kar raha hai.

User kaise use karta hai: Composer mein type karte hi doosri side "typing" state dikh sakti hai (client 4 second timeout).

Andar system mein kya hota hai: Socket event `typing`. Server membership check karta hai; client-supplied `to` ignore hota hai; event real members ko broadcast hota hai.

Kya use hua hai: `server/src/realtime.ts`, engine socket handler.

Kya achieve hua hai: Implementation aur membership guard maujood hain (vitest/realtime path). Is physical-iPhone evening pass mein typing indicators observe nahi hue.

### Feature: Message persistence and chat previews

Yeh kya karta hai: Messages ko server par (ciphertext) aur phone par (decrypted cache) save rakhta hai, aur Chats list mein last preview dikhata hai.

User kaise use karta hai: App band karke kholta hai to purani chats aur last lines wahan milti hain.

Andar system mein kya hota hai: Server `messages` + `message_payloads`. Phone `expo-sqlite` file `understage_<userId>.db` tables `msgs`, `kv`, `outbox`. Preview `lastPreview()` local decrypted bodies se hydrate hoti hai; `lastMessage` ingest bhi ho sakta hai.

Kya use hua hai: better-sqlite3 server, expo-sqlite client.

Kya achieve hua hai: Relaunch ke baad phone cache mein decrypted Alex reply maujood thi. Preview hydration Batch 1 se implemented hai.

### Feature: Message search

Yeh kya karta hai: Chats Home par conversation list ko filter karta hai.

User kaise use karta hai: "Search chats" field mein naam type karta hai; matching titles rehti hain.

Andar system mein kya hota hai: Yeh client-side title filter hai (`title.toLowerCase().includes(q)`). Server message bodies search nahi karta — bodies uske paas plaintext mein hain hi nahi. Individual chat screen ke andar alag full-text message search field nahi hai.

Kya use hua hai: `src/app/(app)/(tabs)/index.tsx` `SearchField`.

Kya achieve hua hai: Chat-list search current Chats Home redesign ka hissa hai aur locally kaam karti hai.

### Feature: Offline outbox, reconnection, and missed-message sync

Yeh kya karta hai: Offline likhe messages ko queue mein rakhta hai, wapas online aane par order se bhejta hai, aur ghayab messages `/sync` se lata hai.

User kaise use karta hai: Offline compose kare to ConnBar "Offline · N waiting to send" dikha sakti hai. Online hote hi send resume hota hai.

Andar system mein kya hota hai: Outbox states `pending | sending | failed | sent`. Offline par kabhi `sent` mark nahi hota. Transient failure par backoff (`1000 * 2^(attempt-1)`, max 60s), per-conversation order preserve. 6 attempts ke baad failed; user Retry kar sakta hai. Crash ke waqt `sending` items load par wapas `pending` ho jate hain — server `client_id` se dedupe karta hai. Reconnect par `GET /sync?since=cursor` (limit 500, max 20 pages) + `syncOutgoingReceipts`.

Kya use hua hai: `shared/outbox.ts`, `GET /sync`, NetInfo + AppState wake.

Kya achieve hua hai: Outbox vitest: offline send nahi, reconnect order, backoff, MAX_ATTEMPTS, crash recovery. Device: 425 ms reconnect delivery; offline-probe HTTP catch-up after terminate+relaunch, no duplicate ids.

### Feature: Duplicate-message prevention

Yeh kya karta hai: Same send ko do dafa store/display nahi karta.

User kaise use karta hai: Retry ya network blip ke baad bhi ek hi bubble dikhti hai.

Andar system mein kya hota hai: Server `UNIQUE (sender_id, client_id)` — duplicate POST pehli message wapas. Client `mergeMessageList` key, `clientId`, aur server id se dedupe karta hai, seq order rakhta hai.

Kya use hua hai: SQLite unique constraint, `shared/message-sync.ts`.

Kya achieve hua hai: Unit tests + live conversation mein zero duplicate ids.

### Feature: Message replies and contextual actions

Yeh kya karta hai: Kis message ka reply hai yeh context ke sath bhejta hai, aur long-press actions deta hai.

User kaise use karta hai: Bubble long-press → reply; naya message quoted context ke sath jata hai. Mentions groups mein `@` se.

Andar system mein kya hota hai: Plaintext payload `replyTo` (message id) aur optional `mentions: [{ userId, username }]`. Yeh fields envelope ke andar encrypt hote hain. UI `Bubble.tsx` quote + mention highlight/suggestions use karti hai.

Kya use hua hai: `PlainMessage` types in `shared/e2ee.ts`, chat/Bubble components.

Kya achieve hua hai: Simulator group chat (Cast company TEST) mein `@am` mention picker aur quoted reply verify hue. 1:1 replies ka data model wahi hai.

---

## 7. MEDIA & ATTACHMENTS

### Feature: Photo attachments

Yeh kya karta hai: Gallery ya camera se photo lekar encrypted chat mein bhejta hai.

User kaise use karta hai: Composer ke "Share securely" sheet se Photo library ya Camera. Caption optional hai.

Andar system mein kya hota hai: `expo-image-picker` file URI deta hai. `sendItem` bytes padhta hai, `encryptBlob` karta hai, ciphertext upload, phir image-type plaintext (jis mein attachment id/key/nonce hain) har member ke liye box hota hai. Server ko raw JPEG/PNG nahi dikhta.

Kya use hua hai: `expo-image-picker` ~58.0.10, `expo-file-system` ~58.0.13, `nacl.secretbox`.

Kya achieve hua hai: Physical iPhone se `m_lHUykMKhNxkR` / `a_5rRRRe9pxbJq` (20:01:41 PKT, seq 16) encrypted upload, persist, Alex tak delivery, valid PNG decrypt. 19:45–19:52 PKT window mein koi image upload/413 error nahi tha — us waqt miss skip/cancel/permission-deny tha, broken encrypt path nahi.

### Feature: Document attachments

Yeh kya karta hai: PDF ya doosri files encrypted bhejta hai.

User kaise use karta hai: Sheet se Document; `expo-document-picker` file choose karta hai. Payload type `doc`.

Andar system mein kya hota hai: Photos jaisa hi secretbox → `/attachments` → boxed metadata. Download par conversation membership check hoti hai.

Kya use hua hai: `expo-document-picker` ~58.0.4.

Kya achieve hua hai: Encrypt/decrypt path vitest-covered hai. Is handset evening pass mein alag document attach re-test nahi hua.

### Feature: Voice-note recording and playback

Yeh kya karta hai: Hold-to-record se voice note banata hai, timer/waveform ke sath bhejta hai, receiver play karta hai.

User kaise use karta hai: Composer par hold karke record, release par send. Receiver bubble se play.

Andar system mein kya hota hai: `expo-audio` microphone se m4a record karta hai (`NSMicrophoneUsageDescription`). Encrypted attachment `audio/m4a`. Plain payload mein `durationSec` aur `waveform` numbers hote hain. Playback local decrypted cache file se.

Kya use hua hai: `expo-audio` ~58.0.11.

Kya achieve hua hai: Outgoing device voice `m_uhp2e7f3zETG` / `a_-UWatBfHbE9K` server attachments table mein maujood, phone cache mein decrypt, Alex par valid M4A (3.46 s) + delivered/read. Timer/waveform chrome aur ek nayi observed recording separately timed nahi hui; pehle wali note decrypt verify ho chuki hai.

### Feature: Encrypted upload, storage, download, decryption

Yeh kya karta hai: File ko raste ke har qadam par ciphertext ki tarah treat karta hai.

User kaise use karta hai: Send ke dauran bubble `encrypting` phir `uploading` stage dikha sakti hai.

Andar system mein kya hota hai: `POST /attachments { conversationId, data }` base64 ciphertext ko BLOB mein rakhta hai (`attachments.data`). Max 25 MB (`413 TOO_LARGE`). Fastify `bodyLimit` 40 MB. `GET /attachments/:id` sirf us conversation ke member ko data wapas karta hai. Client `decryptBlob`; fail par "Could not decrypt this file".

Kya use hua hai: SQLite BLOB storage, membership guard, TweetNaCl secretbox.

Kya achieve hua hai: Photo aur voice dono isi path se live verify hue.

### Feature: Media delivery receipts

Yeh kya karta hai: Media messages ko bhi ordinary messages ki tarah delivered/read ticks milte hain, kyunke woh bhi `messages` + `receipts` rows hain.

User kaise use karta hai: Voice/photo bhejne ke baad wahi sent/delivered/read states dekhta hai.

Andar system mein kya hota hai: Attachment alag table mein hai, lekin message id receipts se judi hai. Voice note par Alex delivered+read mark verify hua.

Kya use hua hai: Same receipt pipeline as text.

Kya achieve hua hai: `m_uhp2e7f3zETG` delivered+read confirm.

---

## 8. GROUP CHATS

### Feature: Group creation and member management

Yeh kya karta hai: Named group chat banata hai, members add/remove karta hai.

User kaise use karta hai: New group screen se title aur members choose karta hai. Admin baad mein members add ya remove kar sakta hai.

Andar system mein kya hota hai: `POST /conversations { kind: "group", title, memberIds }`. 50 se zyada unique members par `GROUP_TOO_LARGE_FOR_E2EE`. `POST /conversations/:id/members` add, `DELETE .../members/:uid` remove, `PATCH .../members/:uid` role change. Non-group par add `400 NOT_A_GROUP`. Role changes `audit_log` likhte hain.

Kya use hua hai: conversation_members.role, `/new-group` screen.

Kya achieve hua hai: Vitest "group fan-out encryption, membership roles, admin-only management" pass. Encrypted groups 50 cap create/add par tested.

### Feature: Member roles and authorization

Yeh kya karta hai: Group ke andar admin vs member farq karta hai.

User kaise use karta hai: Group admin management actions (add/remove/role) dekhta hai; ordinary member unke baghair chat karta hai.

Andar system mein kya hota hai: `conversation_members.role` default `member`. Tests confirm admin-only management. Leave group client par `dropConversation` chalata hai taake chat list se turant hat jaye.

Kya use hua hai: Role column + server checks + `dropConversation`.

Kya achieve hua hai: Authorization server tests se cover; leave instantly list se remove hota hai.

### Feature: Group messages, mentions, replies, read-by

Yeh kya karta hai: Group mein encrypted fan-out messages, @mentions, quoted replies, aur per-member read info deta hai.

User kaise use karta hai: `@` se mention picker, long-press reply, "Read by …" names.

Andar system mein kya hota hai: Har member ke liye alag payload. Mentions/replies plaintext JSON mein (encrypt hone se pehle). `readByUserIds` serialize message se aata hai.

Kya use hua hai: Same e2ee types + Bubble UI.

Kya achieve hua hai: Simulator Cast company (TEST): Amelia Cole mention, send after Retry (`@h200.amelia.cole25 half-hour noted`), quoted reply "Standing by — places set". Per-member read-by names device par separately re-test nahi hue; server `readByUserIds` vitest-covered hai.

### Feature: Group invitations and leaving

Yeh kya karta hai: Logon ko group mein laata hai aur leave allow karta hai.

User kaise use karta hai: Admin members add karta hai (encrypted groups contacts/ids se). Member leave choose karta hai; conversation local list se hat jati hai.

Andar system mein kya hota hai: Add-members endpoint membership + 50 cap enforce karta hai. Leave membership row delete karta hai aur client cache drop karta hai.

Kya use hua hai: members routes + `dropConversation`.

Kya achieve hua hai: Implemented and covered in group management tests.

### Feature: Current membership rules

Yeh kya karta hai: Kon message bhej/receive kar sakta hai yeh rules se bound karta hai.

User kaise use karta hai: Rules silently apply hoti hain — non-member chat nahi dekh ta, blocked 1:1 nahi chalta, oversized group send nahi hota.

Andar system mein kya hota hai:
- Conversation access membership se.
- Typing sirf members ko.
- Encrypted group hard cap 50.
- Workspace chat >50: member list poori, lekin `e2eeError` set, send rejected.
- Wrapped workspace conversations `readonly`.
- Block dono direction messaging/calls rokta hai.

Kya use hua hai: Server guards across conversations, realtime, blocks.

Kya achieve hua hai: Guards vitest mein explicitly tested (caps, visibility, blocks).

---

## 9. WORKSPACE SYSTEM

Hamlet example is section ka zinda reference hai: isolated TEST workspace **"Hamlet UK Tour 2027 (TEST)"**, id `w_M2IFshcmKU84`, seed script `server/scripts/seed-hamlet-200.ts`.

### Feature: Creating workspaces

Yeh kya karta hai: Production/company ke liye named workspace, departments, seat limit, aur company conversation banata hai.

User kaise use karta hai: Plan wala owner naya workspace form bharta hai (name 2–80 chars, optional venue/run label/departments/seatLimit). Free/Crew plan create nahi kar sakta.

Andar system mein kya hota hai: `POST /workspaces` pehle `subscriptions/me` jaisa entitlement padhta hai. `seats <= 0` ya expired/cancelled trial par `403 PLAN_REQUIRED`. `seatLimit` requested aur entitled seats ka minimum hota hai (Production max 50, Company max 200). Creator owner ban jata hai. Departments rows insert hoti hain. Ek `kind='workspace'` conversation bhi banti hai.

Kya use hua hai: `workspaces`, `departments`, `workspace_members`, plan enforcement.

Kya achieve hua hai: Vitest: "free cannot create a workspace; Production clamps to 50 seats; Company up to 200". Hamlet seed ne Alex Rivera ko Company plan de kar TEST workspace banaya (script `NODE_ENV=production` par refuse karti hai, poori DB reset nahi karti, sirf isi TEST company / `h200.*` users / `% (TEST)` groups ko teardown karti hai).

### Feature: Joining, switching, and invitations

Yeh kya karta hai: Invite se workspace join, aur dock/workspace screens se workspace switch.

User kaise use karta hai: Invite link/QR accept karta hai. Stage Dock ke orb menu mein "Switch workspace" cards dikhte hain (name, member count, venue, run label, role, wrapped flag). Workspace tab aur `/workspace/:id` detail bhi hai.

Andar system mein kya hota hai: Accept `workspace_members` insert (`INSERT OR IGNORE`), seat check, aur workspace conversation mein bhi member add. `alreadyMember` duplicate nahi banata.

Kya use hua hai: `/invites/accept`, StageDock workspace switcher, workspace screens.

Kya achieve hua hai: Phone user (`u_875nDU6SAca7` / `syed.umar`) ne 19:46:09 PKT invite `i_g45sG0MQc2Cg` accept ki, role `member`, count wapas 200. Stage Management department `d_fUMdmARHgRig` assign hua.

### Feature: Owners, admins, members, departments, member management

Yeh kya karta hai: Roles aur departments se 200-person company directory chalata hai.

User kaise use karta hai: Workspace screen par department tiles/counts, member list, local time, on/off shift dekhta hai. Admins members ki role/department patch ya remove kar sakte hain.

Andar system mein kya hota hai: Roles `owner | admin | member`. `GET /workspaces/:id/members` filter/search (LIKE wildcards escaped `\`, `%`, `_`). Public member payload mein `localTime`, `onShift`, `wsRole`, `departmentName`, `city`.

Kya use hua hai: `workspace_members.role` + `department_id`, directory UI.

Kya achieve hua hai: Simulator: "8 DEPARTMENTS · 200 PEOPLE" — Cast 34, Wardrobe & Wigs 42, Lighting 18, Sound 14, Set & Crew 30, Front of House 40, Stage Management 12, Production Office 10. Mixed timezones (London, Chicago, Tokyo, New York) aur on/off-shift rows dikhe. Member list `limit=50` 95.4ms / 17ms; `limit=100` ~25ms measure hua.

### Feature: Local times, shift status, and settings

Yeh kya karta hai: Har member ka local clock aur shift server ke clock + us member ki timezone se nikalta hai.

User kaise use karta hai: Directory mein time aur On/Off dekhta hai. Workspace settings screen (`/wsset/:id`) admin options deti hai.

Andar system mein kya hota hai: `publicUser.localTime` `localParts(timezone)` se `HH:MM`. `onShift` `isOnShift`. `PATCH /me` timezone change par `timezoneChanged` return karta hai aur `user:updated` style live update path exist karta hai.

Kya use hua hai: `src/lib/time.ts` (client mirror) aur server util `isOnShift`.

Kya achieve hua hai: Directory local-time/shift Simulator par dekhe gaye. Timezone math vitest-covered.

### Feature: Production wrapping and read-only archives

Yeh kya karta hai: Show khatam hone par workspace ko archive karta hai: chats read-only, invites band, 30-day delete_after mark.

User kaise use karta hai: Admin wrap action; members ko wrapped banner/event milta hai.

Andar system mein kya hota hai: `POST /workspaces/:id/wrap` `wrapped_at` + `delete_after = now + 30 days`, saari workspace conversations `readonly=1`, invites `revoked=1`, `audit_log` `workspace.wrap`, realtime `workspace:wrapped`.

Kya use hua hai: wrap route + audit_log.

Kya achieve hua hai: Server-verified; vitest "200-person workspace, ack tracking, remind w/ quiet hours, wrap → read-only" is flow ko cover karta hai.

### Feature: Hamlet UK Tour 2027 (TEST) — 200 synthetic members ka storage

Yeh kya karta hai: Ek isolated, realistic 200-seat company dataset provide karta hai jisme departments, roles, cities/timezones, aur announcements test ki ja saken.

User kaise use karta hai: App mein workspace "Hamlet UK Tour 2027 (TEST)" dikhai deta hai; phone user uska real member hai.

Andar system mein kya hota hai: Script 8 departments ke counts se synthetic users banati hai (`h200.*` usernames, names FIRST×LAST pools, role lists, cities/timezones London/Edinburgh/Manchester/New York/Chicago/Los Angeles/Paris/Berlin/Tokyo/Sydney). Stage Management ke 12 mein 11 synthetic + Alex shamil hain taake total 200 ho. Users `users` table mein ordinary rows hain (hashed identifiers). Membership `workspace_members` mein department_id ke sath. Script later identity_key (32 random bytes, standard base64) + `key_updated_at` bhi insert kar sakti hai taake encrypted group send path keys ki wajah se fail na ho; in synthetic keys se doosre log decrypt nahi kar sakte kyunke unke paas matching secrets nahi. Script pehle DB backup leti hai (`server/data/understage.db.bak-...`). Idempotent teardown sirf TEST workspace / `h200.*` / `% (TEST)` groups touch karti hai.

Kya use hua hai: `seed-hamlet-200.ts`, better-sqlite3, existing Alex owner (`+44 7700900300` / Alex Rivera) jise Company plan diya gaya.

Kya achieve hua hai: 200-member workspace live API aur Simulator directory se confirm. Real phone user join + department assignment + required ack isi workspace par verify hue.

---

## 10. ANNOUNCEMENTS & ACKNOWLEDGEMENTS

Announcements **end-to-end encrypted nahi** hain. Compose screen yeh user ko batati hai. Server ko title/body padhna parta hai taake ack tracking aur quiet-hours hold ho saken.

### Feature: Creating announcements and member visibility

Yeh kya karta hai: Admin workspace-wide ya department-targeted announcement post karta hai, optional require-ack aur respect-quiet-hours ke sath.

User kaise use karta hai: Admin compose screen (`/compose/:wsId`) title, body, audience (all ya departments), require ack, quiet hours choose karta hai. Members apni list mein sirf woh announcements dekhte hain jinke woh author ya recipient hain.

Andar system mein kya hota hai: `POST /workspaces/:id/announcements` (admin-only, wrapped workspace par nahi). Recipients: author ke siwa tamam members, optional `departmentIds` filter. Har recipient `announcement_recipients` row. Realtime `announcement:new`. `notify()` respectQuiet flag ke sath; off-shift + quiet hours par hold. GET list author ya recipient tak limited.

Kya use hua hai: `announcements` + `announcement_recipients` tables, compose UI.

Kya achieve hua hai: Phone join ke baad announcement `n_HHPqfNM-ft7_` "Call sheet — please acknowledge" (require-ack, 199 recipients) 19:46:14 PKT post hui. Phone `seen_at` 19:46:14 PKT. Purani "Half-hour call — Act I (TEST)" (`a_tnfmSDwF-u5d`) is user ke join se pehle post hui thi, is liye woh uska recipient nahi.

### Feature: Acknowledge action and records

Yeh kya karta hai: Member "Acknowledge" dabata hai; server timestamp record karta hai.

User kaise use karta hai: Announcement khol kar Acknowledge karta hai; apna `ackedAt` dekh sakta hai.

Andar system mein kya hota hai: `POST /announcements/:id/ack` — `require_ack` hona zaroori (`ACK_NOT_REQUIRED` warna). Recipient na ho to `403 NOT_A_RECIPIENT`. `acked_at` aur `seen_at` `COALESCE` se pehli dafa set hote hain. Admins + actor ko `announcement:ack` stats ke sath milta hai. `POST /announcements/:id/seen` alag se first-open time rakhta hai.

Kya use hua hai: ack/seen endpoints, recipient row timestamps.

Kya achieve hua hai: Phone user ka `acked_at` 19:47:04 PKT. API as Alex: `acked` 1 / `total` 199. DB row `announcement_recipients` mein record hai.

### Feature: Progress tracking and department-wise tracking

Yeh kya karta hai: Admin ko dikhata hai kitne logon ne ack kiya, kitne seen-not-acked, kitne not-seen, department ke sath.

User kaise use karta hai: Acknowledgement tracker (`/ack/:id`) tabs/lists: acknowledged vs pending, department labels, counts jaise "142 / 200 acknowledged".

Andar system mein kya hota hai: `GET /announcements/:id/acks` admin-only. Pending vs acknowledged split; `offShift` = pending, not on shift, not yet seen. Department name workspace membership se aati hai (`ws_dept_name`), user profile department se fallback.

Kya use hua hai: ack tracker screen, serialize/stats helpers.

Kya achieve hua hai: Simulator: "142 / 200 acknowledged", 16 seen-not-yet / 42 not-seen-yet, "NOT YET ACKNOWLEDGED (58)". Query ~47.2ms. Curtain pass 2 ke dauran tracker current department dikhane ke liye theek kiya gaya (pehle "Unassigned" dikh sakta tha jab workspace department available thi).

### Feature: Reminder actions and off-shift handling

Yeh kya karta hai: Jin logon ne abhi ack nahi kiya unhe reminder bhejta hai; quiet hours wale hold ho jate hain.

User kaise use karta hai: Admin "Remind" dabata hai. Response counts: reminded, held, deliveredNow.

Andar system mein kya hota hai: `POST /announcements/:id/remind` pending recipients par `reminded_at` set karta hai aur `notify(..., { respectQuiet: announcement.respect_quiet })` chalta hai. Held notifications `held_notifications` table mein jati hain.

Kya use hua hai: remind endpoint + notify/hold pipeline.

Kya achieve hua hai: API measurement: `reminded: 58, held: 15, deliveredNow: 43` in 20.4ms. Simulator HID scroll Remind button tak nahi pohoncha, is liye yeh figure API se verify hui, UI tap se nahi.

### Feature: Time-zone-aware announcement behavior

Yeh kya karta hai: Har recipient ki apni timezone aur shift ke hisaab se decide karta hai ke notification ab jaye ya shift start tak ruke.

User kaise use karta hai: Admin "respect quiet hours" on rakhe to off-shift members ko turant push nahi jati; unke local shift start par hold release / morning summary logic apply hoti hai.

Andar system mein kya hota hai: `isOnShift(user, now)` user ke `work_days`, `shift_start`/`shift_end` (midnight-crossing supported), aur timezone se chalta hai. `quiet_hours` off ho to treat as reachable. Held groups `GET /me/held` par kind/conversation/title se count hoti hain.

Kya use hua hai: server `isOnShift`, `held_notifications`, `/me/held`, `/me/held/release`.

Kya achieve hua hai: Quiet-hours + held-release vitest ("held notifications are released with a single summary push when the shift starts") pass. Remind hold split upar measure hua.

---

## 11. AUDIO CALLING

Yeh section sirf woh describe karti hai jo code mein genuinely maujood hai. Do real devices ke beech live audio call is project par verify nahi hua, is liye UI ko "verified live calling" nahi kaha ja raha.

### Feature: Call screens and history

Yeh kya karta hai: Calls tab outgoing/incoming history dikhati hai, aur in-call UI mute, speaker, timer, end controls rakhti hai.

User kaise use karta hai: Stage Dock se Calls tab, ya contact/chat se audio call button. History rows direction, peer, status, duration dikhati hain.

Andar system mein kya hota hai: `GET /calls` user ki `calls` rows return karta hai (caller/callee, status, started/answered/ended, end_reason, durationSec). Client zustand store `useCall` phases: `idle | outgoing | incoming | connecting | active | ended`.

Kya use hua hai: `src/app/(app)/(tabs)/calls.tsx`, `src/lib/calls.ts`, `calls` table.

Kya achieve hua hai: Physical iPhone ne around 20:30 PKT `GET /calls 200` do dafa issue kiya (Calls tab focused). History API kaam karti hai. Do-device live call is ke sath verify nahi hua.

### Feature: Outgoing and incoming call handling plus signaling

Yeh kya karta hai: Call invite, ring, accept, decline, end, aur SDP/ICE signal relay karta hai.

User kaise use karta hai: Caller "Calling…" / "Ringing…" dekhta hai (callee online ho to Ringing). Callee incoming UI dekhta hai jab app foreground mein socket se connected ho. Accept/decline/end.

Andar system mein kya hota hai: Socket events: `call:invite`, `call:incoming`, `call:accept` / `call:accepted`, `call:decline`, `call:end` / `call:ended`, `call:signal`, `call:answered-elsewhere`. Ring timeout 45 seconds (`RING_TIMEOUT_MS`) → `no-answer`. Callee off-shift + quiet hours par invite `held` ho kar end ho sakti hai ("Missed call … Held during quiet hours"). Signaling payloads client `nacl.box` se seal karta hai `{ n, c }` — server SDP plaintext nahi padhta, sirf relay karta hai.

Kya use hua hai: `server/src/realtime.ts`, sealed `seal`/`open` in `calls.ts`.

Kya achieve hua hai: Realtime vitest: "rejects bad tokens, delivers message:new live, relays WebRTC signaling and call lifecycle". Yeh server/unit level verification hai, live two-device audio nahi.

### Feature: WebRTC integration and native capabilities

Yeh kya karta hai: Peer-to-peer audio media path ready karta hai.

User kaise use karta hai: Dev build (Expo Go mein WebRTC nahi). Microphone permission. In-call mute track disable karta hai; speaker `setAudioModeAsync` se routing change karta hai.

Andar system mein kya hota hai: `react-native-webrtc` lazy require (`NativeModules.WebRTCModule`). `RTCPeerConnection` ICE servers `GET /calls/ice` se — default Google STUN `stun:stun.l.google.com:19302`; TURN sirf jab `TURN_URLS` set ho. Media `getUserMedia({ audio: true, video: false })`. Connection `connected` par phase `active` + timer start. `failed` par end. CallKit / PushKit / VoIP push is Personal Team build mein implement nahi. `app.json` `UIBackgroundModes` mein `audio`, `voip`, `remote-notification` listed hain, lekin free team `aps-environment` sign nahi kar sakti.

Kya use hua hai: `react-native-webrtc` ^155.0.1, `@config-plugins/react-native-webrtc` ^15.0.2, `expo-audio` audio mode.

Kya achieve hua hai: Integration code complete hai. `docs/WEBRTC_TWO_DEVICE_TEST.md` LAN test plan document karta hai aur clearly kehta hai ke calls ko fully end-to-end tab tak claim na kiya jaye jab yeh plan run na ho. TURN default configured nahi. Do-device verification nahi chali.

---

## 12. WORKING HOURS & TIME ZONES

### Feature: Workdays, shift start/end, and local time zones

Yeh kya karta hai: Har user ke kaam ke din aur shift window ko uski IANA timezone mein interpret karta hai.

User kaise use karta hai: Onboarding Step 4 aur baad mein Hours settings se days aur `HH:MM` windows set karta hai. Directory mein doosron ka local time dekhta hai.

Andar system mein kya hota hai: `work_days` JSON array Mon=0..Sun=6. `localParts` `Intl.DateTimeFormat` `en-GB` se weekday + hour/minute nikalta hai. Overnight shifts (`start > end`) do calendar days across handle hoti hain.

Kya use hua hai: `src/lib/time.ts`, server `isOnShift` (client mirror comment ke mutabiq same rules).

Kya achieve hua hai: Vitest "isOnShift handles day + overnight shifts and time zones" pass. Physical user timezone `Asia/Karachi`.

### Feature: On-shift / off-shift status and quiet hours

Yeh kya karta hai: Abhi user reachable hai ya nahi yeh nikalta hai.

User kaise use karta hai: Chats header par "● On shift" ya "☾ Off shift" pill. Quiet hours on hon to off-shift notifications hold ho sakti hain. Quiet hours off hon to `isOnShift` treat-as-reachable (`if (!quiet) return true`).

Andar system mein kya hota hai: Status recipient ki khud ki timezone/shift se calculate hota hai, sender ki nahi.

Kya use hua hai: `ShiftPill`, `isOnShift`, `users.quiet_hours`.

Kya achieve hua hai: Pill current Chats Home par maujood hai. Hold/release tests pass.

### Feature: Touring mode and timezone follow

Yeh kya karta hai: Phone ki system timezone change hone par profile timezone update kar sakta hai, aur working hours ko move ya home zone par chhor sakta hai.

User kaise use karta hai: `followPhoneTz` on ho to app active hote hi `phoneTimezone()` (`expo-localization` calendars) compare karti hai. Change par banner: "Welcome to {city}" — touring mode on ho to hours move, warna pehle zone par rehti hain (banner text ke mutabiq).

Andar system mein kya hota hai: `PATCH /me { timezone }` valid IANA check ke baad save; response `timezoneChanged: { from, to }`.

Kya use hua hai: `expo-localization` ~58.0.5, `checkTimezone()` in engine.

Kya achieve hua hai: Implementation complete. Live timezone-change broadcast is evening batch mein re-test nahi hua; code path maujood hai.

### Feature: Off-shift messaging behavior and morning summary

Yeh kya karta hai: Off-shift + quiet hours par alerts ko hold karta hai, category-wise count rakhta hai, aur shift start par summary release karta hai.

User kaise use karta hai: Off-shift overlay / held counter dekhta hai (`GET /me/held` groups by kind + conversation + title). Shift start par held items release (`POST /me/held/release` tab hi jab abhi on shift ho, warna `409 OFF_SHIFT`).

Andar system mein kya hota hai: `notify()` hold decision. `held_notifications` rows `released_at` null jab tak shift start summary na chale. Vitest ek single summary push assert karta hai.

Kya use hua hai: held table, notify helpers, `/me/held*`.

Kya achieve hua hai: Server-verified hold-and-release. Foreground chat is hold par depend nahi karti — woh Socket.IO se chalti hai.

---

## 13. NOTIFICATION SYSTEM

### Feature: In-app and real-time events

Yeh kya karta hai: App khuli hone par messages, receipts, typing, announcements, key changes, workspace wrap, contacts jaise events turant apply karta hai.

User kaise use karta hai: Screens khud update hoti hain; ConnBar connecting/offline states dikhati hai.

Andar system mein kya hota hai: Socket events `message:new`, `message:status`, `typing`, `conversation:updated`, `contact:added`, `keys:changed`, `announcement:new`, `announcement:ack`, `workspace:wrapped`, `user:updated` (timezone), call events, MLS events (flag on ho). In-app `bus` pub/sub screens ko batata hai.

Kya use hua hai: Socket.IO + `src/lib/events.ts`.

Kya achieve hua hai: Foreground message/receipt events physical iPhone par 149 ms / live read ticks se verify hue.

### Feature: Message alerts, announcement events, reminder handling

Yeh kya karta hai: Server `notify()` se alert route karta hai — online socket, hold, ya push sender.

User kaise use karta hai: Foreground mein chat/announcement UI update. Background banner tab possible hai jab push token + APNs actually configured hon.

Andar system mein kya hota hai: Message push body server plaintext nahi rakhta — text `"New encrypted message"` hai, data mein conversation/message ids. Announcements title server-visible hote hain (E2EE nahi). Reminders same notify path use karti hain.

Kya use hua hai: `notify()` in app.ts, `held_notifications`, `MemoryPushSender` / `ExpoPushSender`.

Kya achieve hua hai: Routing logic implemented aur quiet-hours unit-tested. Expo push sender code `https://exp.host/--/api/v2/push/send` ko 100-message batches mein call kar sakta hai jab `EXPO_PUSH_ENABLED=1`.

### Feature: Native notification code versus active delivery

Yeh kya karta hai: iOS notification permission, Expo token registration, aur notification-tap routing ka client code provide karta hai.

User kaise use karta hai: Pehli dafa permission dialog. Notification tap se chat ya workspace route.

Andar system mein kya hota hai: `src/lib/notifications.ts` `expo-notifications` handler set karta hai; Simulator/unsigned builds throw catch. `registerPush()` physical device + granted permission + EAS `projectId` maangta hai, phir `POST /push/tokens` karta hai. `useNotificationRouting` `conversationId` / `workspaceId` se navigate karta hai. Is Personal Team install (`7SH4DAD2LV`) par `aps-environment` sign nahi ho sakta, is liye remote notification registration active delivery nahi de sakti. `expo-notifications` "Error reading persisted server registration info" is unsigned build par expected hai.

Kya use hua hai: `expo-notifications` ~58.1.8, `expo-device`, `expo-constants`.

Kya achieve hua hai: Client/server hooks maujood hain. Genuinely active background/killed-app APNs delivery is install par nahi hai. Foreground chat ko APNs ki zaroorat nahi — woh WebSocket se verified hai.

---

## 14. SUBSCRIPTIONS & PLANS

Prices `/subscriptions/plans` mein sample prices hain (`samplePrices: true`).

### Feature: Production Plan (£49) and Company Plan (£149)

Yeh kya karta hai: Do paid workspace plans define karta hai, plus free Crew plan.

User kaise use karta hai: Plan / paywall screens (`/plan`, `/paywall`) list dekhta hai:

- Crew (`free`) — £0, 0 seats, 1:1 & group chats, calls. Workspace create nahi.
- Production — £49 / month, 50 seats, product id `com.understage.production.monthly`.
- Company — £149 / month, 200 seats + admin tools (announcements, acks, wrap), product id `com.understage.company.monthly`.

`GET /subscriptions/me` current plan, status, renewsAt, seatsUsed, seatLimit deta hai. `trialDays: 14` plans payload mein listed hai.

Andar system mein kya hota hai: `PLANS` constant `server/src/app.ts`. Entitlement `users.plan` / `plan_status` / `plan_renews_at` se. Expired ya cancelled trial free (0 seats) treat hota hai.

Kya use hua hai: plan constants, `/subscriptions/plans`, `/subscriptions/me`, client plan/paywall screens, `expo-iap` ^6.4.2 client library present.

Kya achieve hua hai: Plan list aur seat math server-enforced. Google Play scope mein nahi. Real App Store sandbox purchase is device par present nahi hua.

### Feature: Backend entitlement enforcement

Yeh kya karta hai: Workspace create aur seat caps ko server par enforce karta hai, sirf client UI par nahi.

User kaise use karta hai: Free user create koshish kare to `403 PLAN_REQUIRED` ("Upgrade to Production or Company to create a workspace"). Seat overflow join `409 WORKSPACE_FULL`.

Andar system mein kya hota hai: `POST /workspaces` entitled seats clamp. Invite accept `count >= seat_limit` reject.

Kya use hua hai: `entitled()` helper from user plan state.

Kya achieve hua hai: Vitest free/Production-50/Company-200 enforcement pass. Hamlet 200-seat company isi cap ke under chalti hai.

### Feature: Purchase verification logic and subscription records

Yeh kya karta hai: App Store signed-transaction JWS ko locally verify karta hai, raw transactionId par plan nahi deta.

User kaise use karta hai: IAP flow se `{ signedTransaction, planId?, transactionId? }` `POST /subscriptions/verify` jata hai.

Andar system mein kya hota hai: `server/src/iap.ts` ES256 + `x5c` chain ko configured Apple root CAs se verify karta hai (`APPLE_ROOT_CA_PEM`, `APPLE_IAP_ROOTS_DIR`, ya `IAP_VERIFY_ENABLED=1` + `server/certs/`). App Store Connect API key zaroori nahi. Results:
- koi trusted roots nahi → `501 IAP_NOT_CONFIGURED`, entitlement nahi
- invalid/untrusted/mismatched/wrong bundle/unknown product → `400 IAP_UNVERIFIED`
- valid lekin `expiresDate` past → `400 IAP_EXPIRED` (existing plan unchanged)
- valid JWS known product ke liye → `200`, `plan_status='active'`, `plan_renews_at=expiresDate`
`{ dev: true }` / `SUBSCRIPTIONS_DEV` ab trial grant nahi karta. Bundle id default `com.kvmac.understage`.

Kya use hua hai: Node `crypto` X509 + verify, `server/test/iap.test.ts` (local P-256 test certs).

Kya achieve hua hai: JWS verification unit-tested (accept trusted chain, reject untrusted/tampered/mismatched bundle, refuse raw transactionId/dev flag, grant only after trusted JWS, refuse expired/unknown products). Live environment roots configured nahi, is liye endpoint `501` rehta hai jab tak roots na hon. Koi real StoreKit sandbox JWS is device se verify nahi hua.

---

## 15. SECURITY & PRIVACY

### Feature: Authentication security

Yeh kya karta hai: Har protected API ko valid, unrevoked, unsuspended session se bind karta hai.

User kaise use karta hai: Login ke baad ordinary use; expiry par app refresh token se naya access token leti hai.

Andar system mein kya hota hai: `Authorization: Bearer` JWT HS256, `typ=access`, session revoke check, suspension check (`403 SUSPENDED`). Refresh reuse detection session revoke karti hai. Identifier peppered hash.

Kya use hua hai: `jsonwebtoken` 9.0.3, `server/src/auth.ts`.

Kya achieve hua hai: Auth suite vitest + live session persistence.

### Feature: Secure local storage and encryption

Yeh kya karta hai: Secrets Keychain mein, messages device cache mein, server par ciphertext.

User kaise use karta hai: Ordinary chat; keys hidden.

Andar system mein kya hota hai: Section 4. Physical device file fallback inkaar. Attachment blobs encrypted. Push bodies message plaintext nahi rakhti.

Kya use hua hai: expo-secure-store, tweetnacl, Data Protection on app files.

Kya achieve hua hai: Device Keychain persistence verified; server ciphertext-only verified.

### Feature: Safety numbers, blocking, reporting

Yeh kya karta hai: Identity check, user block, aur abuse report (optional selected decrypted messages + optional also-block).

User kaise use karta hai: Safety screen verify. Privacy/blocked list. Report screen se reason choose, specific messages select (apne phone par decrypt karke), optionally block; us chat list se hat sakti hai.

Andar system mein kya hota hai: Block table bidirectional messaging/calls rokta hai. `POST /reports` evidence JSON save karta hai — sirf woh messages jo reporter ne choose kiye (decrypt client par). Rate limit reports 8/min. Admin queue in reports ko dekhti hai; baqi E2EE content admin ko nahi milta.

Kya use hua hai: `/blocks`, `/reports`, `src/app/(app)/report/[userId].tsx`, `blocked.tsx`.

Kya achieve hua hai: Vitest reports + block; "blocking prevents messaging and calls". Report+optional-block server-verified.

### Feature: Permissions, RBAC, and workspace isolation

Yeh kya karta hai: User, conversation, workspace, aur admin actions ko role/membership se limit karta hai.

User kaise use karta hai: Member announcements compose nahi kar sakta; admin/owner kar sakta hai. Doosre workspace ka data nahi dikhta.

Andar system mein kya hota hai: `wsMember` / `wsAdmin` / `memberOf` guards. Workspace members search escape. `GET /users/:id` isolation. Conversation payloads sirf us recipient ki copy return. Wrapped workspace writes block (`notWrapped`).

Kya use hua hai: Fastify preHandlers + helper guards.

Kya achieve hua hai: Isolation tests (user visibility, workspace search escape, admin-only acks list).

### Feature: Rate limiting and admin audit logging

Yeh kya karta hai: Abuse volume kam karta hai aur sensitive admin/workspace actions ka hisaab rakhta hai.

User kaise use karta hai: Limit cross hone par `429 RATE_LIMITED`. Admin dashboard Audit view.

Andar system mein kya hota hai: In-memory per-process buckets: search 30/min, messages 40/min, attachments 20/min, reports 8/min, invites 15/min; MLS key-package fetch 60/min. `audit_log` writes: admin report status, suspend/unsuspend, workspace wrap, conversation/workspace role changes. `GET /admin/audit`.

Kya use hua hai: `rateBuckets` Map, `audit_log` table.

Kya achieve hua hai: Rate-limit aur audit_log vitest pass. Seeded demo data ne pehle audit rows nahi likhin; admin action ke baad row banti hai.

### Feature: Secure attachment handling

Yeh kya karta hai: Encrypted blobs ko conversation members tak mehdood rakhta hai.

User kaise use karta hai: Sirf us chat ke log file download/decrypt kar sakte hain.

Andar system mein kya hota hai: Upload membership required; download membership required; 25 MB cap; ciphertext only.

Kya use hua hai: `/attachments` routes.

Kya achieve hua hai: Live photo/voice isi guard se guzre; vitest attachment encrypt/decrypt.

---

## 16. WEB ADMIN DASHBOARD

Dashboard `GET /admin` se plain HTML/CSS/JS serve hota hai (`server/admin/index.html` + `app.js`). Koi extra npm UI framework nahi. Look dark + gold, Understage branding ke qareeb.

### Feature: Admin authentication

Yeh kya karta hai: Admin APIs ko ya to shared `x-admin-token` se, ya `is_admin` user JWT se protect karta hai.

User kaise use karta hai: Browser `/admin` kholta hai, login form. UI files khud bina auth ke serve hoti hain; APIs protect hain. sessionStorage session rakhti hai.

Andar system mein kya hota hai: `adminAuth`: agar `cfg.adminToken` set ho aur header match kare to `userId='admin'`; warna ordinary Bearer auth + `users.is_admin`. Live `ADMIN_TOKEN` empty hone par token-login disabled rehta hai; `is_admin` JWT se login possible hai.

Kya use hua hai: Fastify admin preHandler, admin SPA.

Kya achieve hua hai: Vitest: "serves the web admin UI without auth and keeps admin APIs protected"; "x-admin-token authenticates". Chrome session isolated `understage.ops` se: dashboard open hua.

### Feature: Reports management and selected-message reporting

Yeh kya karta hai: Reporter ke choose kiye hue decrypted messages ko queue mein dikhata hai, status update karta hai.

User kaise use karta hai: Admin Reports tab mein evidence cards dekhta hai. Note UI par: "Everything else stays end-to-end encrypted. Admins only see what the reporter chose to share." Status update (open/review/resolved etc.) audit log likhta hai.

Andar system mein kya hota hai: `GET /admin/reports`, `PATCH /admin/reports/:id`. Evidence server par reporter-supplied JSON hai.

Kya use hua hai: reports table + admin UI.

Kya achieve hua hai: Chrome par reports queue with shared evidence dekhi gayi. Server tests reports flow cover karte hain.

### Feature: User suspensions and unsuspend

Yeh kya karta hai: User ko 7 days, 30 days, ya permanent suspend karta hai, list dikhata hai, unsuspend karta hai.

User kaise use karta hai: Admin Suspend actions; Suspensions list se Unsuspend.

Andar system mein kya hota hai: `POST /admin/suspensions`, `GET /admin/suspensions`, `DELETE /admin/suspensions/:id` (lift). User `suspended_until` / reason update; login/API `403 SUSPENDED`. Audit entries.

Kya use hua hai: `suspensions` table + users suspension columns.

Kya achieve hua hai: Chrome UI 7/30/Permanent + Unsuspend verified. Vitest suspensions cover.

### Feature: Support tickets

Yeh kya karta hai: User tickets aur admin replies manage karta hai.

User kaise use karta hai: App mein `/support` se ticket kholta hai (`POST /support/tickets`, messages, `GET /support/tickets/:id` user-scoped). Admin dashboard tickets list, thread, reply, "Send & close".

Andar system mein kya hota hai: `tickets` + `ticket_messages`. Admin `GET/POST/PATCH /admin/tickets/:id`.

Kya use hua hai: support routes + admin UI.

Kya achieve hua hai: Chrome par support tickets with reply and send-and-close dekhe gaye. User-scoped GET vitest-covered.

### Feature: Workspace statistics and audit logs

Yeh kya karta hai: Workspaces KPIs (active / members / wrapped, owner column) aur audit trail dikhata hai.

User kaise use karta hai: Workspaces tab KPIs; Audit tab actions ki list.

Andar system mein kya hota hai: `GET /admin/workspaces` aggregates; `GET /admin/audit` `audit_log` se, newest first.

Kya use hua hai: SQL aggregates + audit table.

Kya achieve hua hai: Chrome par workspace KPIs dekhe gaye. Audit view tab empty thi jab tak koi admin action record na kare (seed ne rows nahi likhin). Vitest workspace stats include owner and member totals.

### Feature: Admin permissions

Yeh kya karta hai: Sirf token ya `is_admin` users moderation endpoints chala sakte hain.

User kaise use karta hai: Ordinary user in URLs ko hit kare to 401/403.

Andar system mein kya hota hai: `adminAuth` upar describe hai. UI ke dashboard actions inhi APIs ko call karti hain.

Kya use hua hai: `users.is_admin`, optional `ADMIN_TOKEN`.

Kya achieve hua hai: Protection tests pass; Chrome login admin user se hua.

---

## 17. CURTAIN UI/UX DESIGN

Curtain (Design 1) approved direction hai: dark plum/black stage, champagne-gold accents, Playfair Display + Inter typography, glass surfaces, Stage Dock, gold orb. Implementation existing Expo Router app ke andar theme tokens aur shared components se hui — naya project nahi banaya gaya.

### Feature: Overall design identity, colours, and typography

Yeh kya karta hai: Poori app ko ek shared visual language deta hai.

User kaise use karta hai: Har screen par dark velvet background, gold highlights, serif headings, sans body text dikhai dete hain.

Andar system mein kya hota hai: `src/theme.ts` tokens:

- Backgrounds: `bg #0B0A0C`, `bgPlum #140C14`, `card #161018`, `input #201820`, `glass rgba(22,16,26,0.82)`
- Gold: `#D8B26A`, gold text `#1a1208`, soft/glow overlays
- Status: red `#B3263E`, green `#3FB27F`, muted `#9A8F99`, text `#F3EDE4`
- Gradients: page `#3a1420 → #160A12 → #0B0A0C`, hero `#5c1428 → #2a0c18 → #12080e`, gold metallic, dock glass
- Type: Playfair Display 600/700 (`serif`, `serifBold`); Inter 300–800
- Radii/spacing: card 20, button 16, `DOCK_SPACE` 108

Fonts `@expo-google-fonts/inter` 0.4.2 aur `@expo-google-fonts/playfair-display` 0.4.2 se load hoti hain. `CurtainBg` page gradient wrapper hai.

Kya use hua hai: `src/theme.ts`, `src/components/CurtainBg.tsx`, `expo-linear-gradient` ~58.0.3, `expo-font` ~58.0.11.

Kya achieve hua hai: Shared token system screens mein compile-safe keys ke sath land hua. Simulator par Curtain pass 2 visually apply hua (Chats, chat composer, workspace hero, ack, orb).

### Feature: Shared design system and reusable components

Yeh kya karta hai: Buttons, inputs, cards, avatars, sheets, overlays, icons ek jagah se style karta hai.

User kaise use karta hai: Consistent gold buttons, glass rows, avatar rings, dialogs.

Andar system mein kya hota hai: `src/components/ui.tsx` (`T`, `Tap`, `Button`, `Card`, `Row`, `Avatar`, `Pill`, `Sheet`-related pieces, `SearchField`, `Empty`, `Badge`, `Screen`). `Sheet.tsx`, `Overlays.tsx` (toasts, banners, confirm dialogs), `Icon.tsx`, `Bubble.tsx`, `Hours.tsx`. Animations `react-native-reanimated` 4.7.1 (orb pulse, FadeIn/FadeOut, ZoomIn spring on arc actions) aur `react-native-gesture-handler` ~3.3.0.

Kya use hua hai: existing component library + Curtain tokens.

Kya achieve hua hai: Redesign ne architecture replace nahi ki; tokens/components reuse kiye.

### Feature: Stage Dock, gold action orb, arc menu, workspace switcher

Yeh kya karta hai: Bottom navigation ko floating glass dock banata hai, beech mein pulsing gold orb, jo advanced actions aur workspace switch kholta hai.

User kaise use karta hai: Dock par Chats / Workspace / (orb) / Calls / Settings. Orb tap se dark overlay, upar workspace cards ("Switch workspace"), neeche arc actions: New chat, Scan QR, Announce (agar user kisi unwrapped workspace ka owner/admin ho), Call. Orb dubara tap se band. Unread badge Chats tab par.

Andar system mein kya hota hai: `src/components/StageDock.tsx` custom tab bar. Safe area `paddingBottom: max(inset, 8) + 6`. Modal fade. `bus` event `dock:open`. Navigation `expo-router`.

Kya use hua hai: Reanimated, LinearGradient, SafeAreaInsets.

Kya achieve hua hai: Simulator par orb arc aur workspace switcher capture hue (`07-orb` style verification during Curtain pass 2). Functional taps (chat, +, contacts, orb, tabs) Simulator par kaam karte dekhe gaye, GO_BACK overflow us pass ke context mein deep-link fix ke baad nahi aaya.

### Feature: Chats Home screen (Curtain + composition redesign)

Yeh kya karta hai: Conversation list, on-shift crew strip, pinned workspace entry, search, aur Stage Dock ke sath balanced home deta hai.

User kaise use karta hai: Header mein serif "Chats" + On/Off shift pill, right par new-group aur gold + (add contact). Search field. Horizontal crew strip on-shift direct contacts ki chhoti gold-ring avatars (44px) ke sath, naam first-name + single-line truncation. Neeche compact glass pinned workspace row (initial avatar, name + lock, "Pinned · unread · venue", stacked member avatars, count). Phir tighter conversation rows (avatar, name, preview, time, unread, encryption status). List bottom padding dock + home indicator se last chat cover nahi hoti.

Andar system mein kya hota hai: Sirf `src/app/(app)/(tabs)/index.tsx` is composition pass mein target tha. Crew `ScrollView horizontal` clipping parent `crewWrap` ke andar. Pins workspaces se map. Rows local decrypted previews use karti hain. `listBottom = 80 + max(bottom inset, 8) + 16`.

Kya use hua hai: existing engine data + Curtain tokens + StageDock spacing.

Kya achieve hua hai: Pehle physical iPhone 11 Pro screenshot mein oversized avatars, clipped names, pinned card overlap, aur right-edge overflow dikha. Redesign ke baad layout compact/clipped-correct likha gaya; TypeScript us change par clean tha. Design iPhone par Wi-Fi relaunch **10:14 PM PKT (Asia/Karachi)** ko load hui. Composition screenshots iPhone 17 Pro Simulator viewport se liye gaye (woh 11 Pro se thora wider hai). Functional checks Simulator par: chat open, +, contacts, orb, tabs — overflow/clip/overlap us verification mein nahi dikhe.

### Feature: Chat conversation, workspace, announcements, ack, settings, onboarding

Yeh kya karta hai: Baqi existing routes ko Curtain tokens, glass surfaces, aur dock-aware layout se style karta hai.

User kaise use karta hai:
- Chat: floating glass composer, gold sent bubbles, dark receive bubbles, attachments/voice UI
- Workspace: velvet hero, department tiles, member directory
- Announcements/compose: gold/admin tools
- Ack tracker: pending/acked lists, department labels
- Settings / profile / hours / privacy / blocked / plan / support: same palette
- Onboarding/auth: same tokens (serif headers, gold primary buttons)

Andar system mein kya hota hai: Theme import across tab and stack screens. Curtain pass 2 ke dauran related screen files update hue (git status unhi `src/app` / `src/components` / `src/theme.ts` paths ko modified dikhata hai, plus new `CurtainBg.tsx` / `StageDock.tsx`).

Kya use hua hai: Expo Router stack+tabs, shared UI.

Kya achieve hua hai: Simulator visual pass 2: Chats (us waqt pehli Curtain composition), chat floating composer, workspace velvet hero + department tiles, ack department fix, orb/switcher. Auth/onboarding visual device pass sign-out ke baghair nahi chala (existing encrypted session preserve rakhne ke liye). `mls-selftest` hidden dev screen hai aur product Curtain restyle uska target nahi tha.

### Feature: Screen inventory (current implementation status)

Yeh kya karta hai: Yeh factual map batata hai ke kaunsi route codebase mein maujood hai aur uska design/verification status kya recorded hai.

User kaise use karta hai: User inhi routes ke through app chalta hai — tabs, stack screens, sheets, aur hidden dev self-test.

Andar system mein kya hota hai: Expo Router file-based screens `src/app` ke andar hain. Neeche table har route ka current implementation/verification status likhti hai (pending-work list nahi, balki recorded fact).

Kya use hua hai: `src/app/**/*.tsx`, Curtain theme/components, pehle recorded Simulator/device checks.

Kya achieve hua hai: Tamam listed routes code mein maujood hain. Jahan visual ya device check record hai woh column mein likha hai; jahan check record nahi, wahan implementation maujood hone ko fact ke taur par kaha gaya hai.

| Route | Kya hai | Implementation / verification (factual) |
| --- | --- | --- |
| `(auth)/index` | Welcome / Get started / Sign in | Curtain tokens in file; visual device pass recorded nahi (session preserve) |
| `(auth)/verify` | Phone/email OTP | Implemented; physical login earlier completed; later visual restyle untested without sign-out |
| `(onb)/profile` | Step 2 profile | Implemented; completed on device earlier |
| `(onb)/identity` | Step 3 visibility | Implemented |
| `(onb)/hours` | Step 4 hours | Implemented |
| `(onb)/keys` | Step 5 encryption identity | Implemented; device key setup verified |
| `(tabs)/index` | Chats Home | Curtain + later composition redesign; Simulator verified; Wi-Fi reload 10:14 PM PKT (Asia/Karachi) |
| `(tabs)/workspace` | Workspace tab | Curtain + velvet/departments in pass 2 Simulator |
| `(tabs)/calls` | Call history | Implemented; phone `GET /calls 200` ~20:30 PKT; row chrome hairline-style in that pass |
| `(tabs)/settings` | Settings | Implemented; no mount fetch, visual confirm recorded as still needed at 20:34 matrix time |
| `chat/[id]` | Conversation | Floating composer restyle; 1:1 E2EE/media device-verified |
| `workspace/[id]` | Workspace detail | Departments/members; Hamlet verified |
| `ack/[id]` | Ack tracker | Implemented; department label fix in pass 2; Simulator + API verified |
| `compose/[wsId]` | New announcement | Implemented; server-verified |
| `add`, `scan`, `myqr` | Contacts / QR | Implemented; username add device-verified; My QR Simulator; camera scan not exercised on this iPhone |
| `new-group` | Create group | Implemented |
| `invite/[token]` | Accept invite | Implemented; deep-link resolve 200 from phone IP; visual restyle pass recorded nahi |
| `edit-profile`, `hours-settings` | Profile/hours edit | Implemented |
| `paywall`, `plan` | Subscription UI | Implemented; IAP verify 501 without roots |
| `privacy`, `blocked` | Privacy + block list | Implemented |
| `report/[userId]` | Report + optional block | Implemented; server-verified |
| `safety/[id]` | Safety number | Implemented; algorithm tested |
| `support/index`, `support/[id]` | Tickets | Implemented; API tested; `[id]` visual restyle pass recorded nahi |
| `wsset/[id]` | Workspace settings / wrap | Implemented; wrap server-verified |
| `mls-selftest` | Dev MLS self-test | Phase 1 Simulator PASS; product restyle target nahi |

---

## 18. TECHNOLOGIES, LIBRARIES & SERVICES

Yeh names aur versions `package.json` manifests se liye gaye hain. Guess nahi.

### Mobile application (`package.json`, name `understage` 1.0.0)

| Name | Version | Purpose / Understage mein kaam |
| --- | --- | --- |
| expo | ~58.0.23 | Application platform, prebuild, dev client |
| react | 19.3.0 | UI runtime |
| react-native | 0.88.1 | iOS native UI |
| expo-router | ~58.0.30 | File-based navigation (`src/app`) |
| expo-dev-client | ~58.0.18 | Custom dev build (WebRTC/IAP Expo Go mein nahi chalte) |
| typescript | ~6.0.3 (app devDep) | Typecheck (`tsc --noEmit`) |
| zustand | ^5.0.16 | App store (`src/store/app.ts`) aur call store |
| @expo-google-fonts/inter | ^0.4.2 | Body typography |
| @expo-google-fonts/playfair-display | ^0.4.2 | Serif headings (Curtain) |
| expo-font | ~58.0.11 | Font loading |
| expo-linear-gradient | ~58.0.3 | Page/dock/gold gradients |
| expo-status-bar | ~58.0.4 | Status bar |
| expo-linking | ~58.0.16 | Deep links / scheme `understage` |
| expo-constants | ~58.0.15 | Extra config / projectId lookup |
| expo-localization | ~58.0.5 | Phone timezone, calendars |
| expo-device | ~58.0.5 | Physical vs Simulator (secure fallback, push) |
| expo-secure-store | ~58.0.2 | Keychain session + identity |
| expo-sqlite | ~58.0.15 | Local decrypted cache + outbox |
| expo-crypto | ~58.0.7 | CSPRNG for tweetnacl + UUIDs |
| expo-file-system | ~58.0.13 | Attachment bytes read/write |
| expo-image-picker | ~58.0.10 | Photo library / camera stills |
| expo-document-picker | ~58.0.4 | Document attach |
| expo-camera | ~58.0.14 | QR scan + camera capture permission |
| expo-audio | ~58.0.11 | Voice notes + in-call audio mode |
| expo-notifications | ~58.1.8 | Notification handler, token, routing |
| expo-haptics | ~58.0.7 | Haptic feedback |
| expo-iap | ^6.4.2 | StoreKit/IAP client bindings |
| @react-native-community/netinfo | 12.0.1 | Online/offline → wakeRealtime |
| socket.io-client | ^4.8.4 | Realtime websocket |
| tweetnacl | ^1.0.3 | E2EE box/secretbox |
| tweetnacl-util | ^0.15.1 | Base64/UTF8 helpers |
| react-native-webrtc | ^155.0.1 | Audio call media |
| @config-plugins/react-native-webrtc | ^15.0.2 | Expo config plugin for WebRTC |
| react-native-qrcode-svg | ^6.3.52 | My QR rendering |
| react-native-svg | 15.16.0 | SVG + QR support |
| react-native-reanimated | 4.7.1 | Dock/orb animations |
| react-native-worklets | 0.13.0 | Reanimated 4 worklets runtime |
| react-native-gesture-handler | ~3.3.0 | Gestures |
| react-native-safe-area-context | ~5.11.1 | Safe areas / dock insets |
| react-native-screens | ~4.30.1 | Native navigation screens |
| eslint | ^9.0.0 | Lint |
| eslint-config-expo | ~58.0.4 | Expo ESLint preset |
| patch-package | ^8.0.1 | `postinstall` applies `patches/expo-modules-jsi+58.0.22.patch` |
| @types/react | ~19.3.0 | TS types |

`main` entry `expo-router/entry`. Scripts: `start` (dev-client), `ios`, `typecheck`, `lint`, `test` (delegates to server vitest), `mac:setup` / `mac:launch`.

### Native MLS module (`modules/understage-mls/package.json`)

| Name | Version | Purpose |
| --- | --- | --- |
| understage-mls | 0.1.0 | Expo module wrapping OpenMLS 0.9.2 via UniFFI; hidden self-test; production send path is se nahi jata jab directory flag off ho |

Locked crates (Phase 0/1 docs): `openmls` 0.9.2, `openmls_rust_crypto` 0.6.0, `openmls_basic_credential` 0.6.0, `openmls_sqlite_storage` 0.3.0, `openmls_traits` 0.6.0, `uniffi` 0.32.2.

### Backend (`server/package.json`, name `understage-server` 1.0.0)

| Name | Version | Purpose / Understage mein kaam |
| --- | --- | --- |
| fastify | ^5.12.8 | HTTP API server |
| @fastify/cors | ^11.4.0 | CORS (`origin: true`) |
| better-sqlite3 | ^11.10.0 | SQLite database |
| socket.io | ^4.8.4 | Realtime (messages, typing, calls, MLS events) |
| jsonwebtoken | ^9.0.3 | Access tokens HS256 |
| zod | ^4.6.7 | Request validation |
| tsx | ^4.23.15 | Dev runner (`tsx watch src/index.ts`) |
| typescript | ^7.0.2 (server) | Server typecheck |
| vitest | ^4.1.12 | Server/unit tests (`vitest run`) |
| socket.io-client | ^4.8.4 (server devDep) | Realtime tests |
| tweetnacl / tweetnacl-util | ^1.0.3 / ^0.15.1 (server devDep) | E2EE tests encrypt/decrypt |
| @types/better-sqlite3 | ^9.6.0 | Types |
| @types/jsonwebtoken | ^9.0.10 | Types |
| @types/node | ^26.6.6 | Node types |

Admin dashboard ka alag package.json nahi — woh Fastify se static HTML/JS serve hota hai, koi extra UI dependency nahi.

### Shared modules

`shared/` ka apna package.json nahi. Yeh TypeScript files app aur server tests dono use karte hain: `e2ee.ts`, `outbox.ts`, `message-sync.ts`, `deep-link.ts`.

### Services present in code (configured vs active)

- **Twilio SMS** — `TwilioOtpSender` written; current dev `ConsoleOtpSender` use karta hai jab `SMS_PROVIDER=twilio` set na ho.
- **Expo Push API** — `ExpoPushSender` written; active delivery ke liye `EXPO_PUSH_ENABLED=1` + APNs/token chahiye.
- **Apple IAP JWS verification** — local crypto verification written; roots ke baghair `501`.
- **STUN** — default Google STUN for calls; TURN optional env.

---

## 19. BACKEND & DATABASE ARCHITECTURE

### Feature: Backend structure and API routing

Yeh kya karta hai: Ek Node process HTTP + WebSocket dono serve karti hai.

User kaise use karta hai: App `EXPO_PUBLIC_API_URL` (LAN example `http://192.168.100.91:4000`) par REST call karti hai; socket same origin (ya `EXPO_PUBLIC_SOCKET_URL`).

Andar system mein kya hota hai: `server/src/index.ts` server sunta hai `0.0.0.0:4000` (default). `buildApp()` Fastify instance: logger false, bodyLimit 40 MB, CORS, request logging hook, error handler (`HttpError` → `{ error, message }`, Zod → `VALIDATION`, 500 `INTERNAL` bina stack ke client ko). Auth preHandler Bearer JWT. Routes include: health, admin UI, auth, me/users, contacts, invites, blocks, reports, conversations/messages/sync/receipts, attachments, workspaces/announcements/acks/wrap, held notifications, calls/ice, push tokens, subscriptions, support, admin moderation, MLS directory (flagged).

Kya use hua hai: Fastify 5, Zod 4, Socket.IO 4.

Kya achieve hua hai: Live `:4000` physical iPhone (192.168.100.35) aur Simulator dono se use hua. Dev request log `[http] METHOD path status ip` query strings strip karta hai, bodies/tokens nahi likhta; production/test mein off unless `REQUEST_LOG=1`.

### Feature: Authentication middleware

Yeh kya karta hai: Protected routes ko user id se decorate karta hai.

User kaise use karta hai: Invisible — 401 par app refresh/sign-out karti hai.

Andar system mein kya hota hai: `verifyAccess` + session revoked + suspension. Socket handshake `auth.token` same verifier use karta hai, phir `socket.join('user:' + userId)`.

Kya use hua hai: `auth.ts`, realtime `io.use`.

Kya achieve hua hai: Bad socket tokens realtime test mein reject hue; valid device session persist hui.

### Feature: Database technology, models, and persistence

Yeh kya karta hai: Ek SQLite file mein tamam server state rakhta hai (WAL, foreign_keys ON).

User kaise use karta hai: Direct DB nahi dekhta; uska data users, messages, workspaces waghera tables mein rehta hai.

Andar system mein kya hota hai: `better-sqlite3`, `openDb(file)`. Tables: `users`, `otps`, `sessions`, `contacts`, `blocks`, `workspaces`, `departments`, `workspace_members`, `conversations`, `conversation_members`, `messages`, `message_payloads`, `receipts`, `attachments`, `announcements`, `announcement_recipients`, `invites`, `reports`, `suspensions`, `tickets`, `ticket_messages`, `push_tokens`, `held_notifications`, `calls`, `audit_log`, plus MLS `mls_key_packages`, `mls_groups`, `mls_messages`, `mls_welcomes`. `migrateMls()` purani DBs par additive columns.

Message persistence: seq autoincrement, unique message id, unique `(sender_id, client_id)`. Encrypted attachments: BLOB + size + owner + conversation. Workspace/group/announcement/subscription fields upar sections mein.

Kya use hua hai: SQLite file (default path config `DB_FILE`), indexes on messages, payloads, members, MLS.

Kya achieve hua hai: Live Hamlet + Alex/Syed conversations isi DB mein record hue. Backup before original 200 seed: `server/data/understage.db.bak-20261105-154151`.

### Feature: Real-time, admin, errors, logging, end-to-end data flow

Yeh kya karta hai: HTTP writes ke baad relevant users ko socket events bhejta hai, errors ko stable codes deta hai, aur admin actions log karta hai.

User kaise use karta hai: Instant UI updates; readable error toasts (`CODE_INCORRECT`, `RATE_LIMITED`, etc.).

Andar system mein kya hota hai: Example flow — send message: client encrypt → POST → INSERT messages/payloads/receipts → emit `message:new` har member (unke apne payload ke sath) → optional notify → recipient decrypt → POST delivered → emit `message:status` sender ko. Announcement flow similar with plaintext + recipients + hold. Admin flow: JWT/`x-admin-token` → SQL update → `audit_log` → dashboard refresh.

Kya use hua hai: LateEmitter, http-log, HttpError codes.

Kya achieve hua hai: End-to-end flow physical 1:1 chat, workspace ack, aur Chrome admin par observe/verify hua.

---

## 20. TESTING & VERIFIED ACHIEVEMENTS

Is section mein sirf woh results hain jo actually run/observed hue. Invented pass marks nahi hain. Is report ki writing ke dauran naya test run nahi chalaya gaya; figures recorded verification se hain, aur current test files count cross-check hua.

Current server test files ke `it()` counts (source read, 5 November 2026):

- `api.test.ts` — 22
- `deep-link.test.ts` — 8
- `iap.test.ts` — 5
- `message-sync.test.ts` — 4
- `mls-directory.test.ts` — 9
- `outbox.test.ts` — 3
- `realtime.test.ts` — 1
- **Kul 52 cases** (7 files; `helpers.ts` mein koi `it` nahi)

### Feature: Backend tests (vitest)

Yeh kya karta hai: Auth, E2EE, receipts, QR/invites, 200-person workspace/acks/remind/wrap, quiet hours, admin/subscriptions/support, plan enforcement, E2EE caps, visibility, rate limits, search escape, audit log, IAP JWS, message merge/sync, MLS directory flag, outbox, realtime signaling cover karta hai.

User kaise use karta hai: Developer `cd server && npm test` (`vitest run`).

Andar system mein kya hota hai: In-memory SQLite, injectable clock/otp/push/emit, real tweetnacl in tests.

Kya use hua hai: vitest ^4.1.12.

Kya achieve hua hai: 5 November 2026 t37u pass: `vitest run` 7 files / 51 tests passed; us waqt `npm --prefix server run typecheck` aur root `npm run typecheck` pass. Baad mein deep-link tests curtain dock query preservation ke sath barhe. Curtain pass 2 recorded result: **vitest 52/52**, **tsc 0 errors**, no new lint issues. File count aaj bhi 52 cases hai.

### Feature: TypeScript checks and lint

Yeh kya karta hai: App aur server types compile karta hai; Expo ESLint `src` check karta hai.

User kaise use karta hai: `npm run typecheck`, `npm --prefix server run typecheck`, `npx eslint src` / `npm run lint`.

Andar system mein kya hota hai: Root `tsc --noEmit` (tsconfig), server alag tsconfig.

Kya use hua hai: TypeScript ~6.0.3 (app) / ^7.0.2 (server), eslint-config-expo.

Kya achieve hua hai: Multiple recorded clean typechecks (Phase 2, t37u, Curtain pass 2 tsc 0). Chats Home redesign ke baad bhi TypeScript clean report hua. Is document ke liye lint/tsc dubara nahi chalaye.

### Feature: iOS native compilation and Simulator installation

Yeh kya karta hai: Dev client ko Xcode se Simulator/device ke liye build karta hai.

User kaise use karta hai: `npx expo run:ios` / project `mac:launch` scripts. Expo Go is app ke liye kaafi nahi (WebRTC, IAP, MLS native).

Andar system mein kya hota hai: Xcode 26.3, Expo SDK 58 modules source-compiled (`EXPO_USE_PRECOMPILED_MODULES=0`). Phase 1 `xcodebuild` final BUILD_EXIT 0 at 16:55:15 PKT; Simulator install `xcrun simctl install booted` iPhone 17 Pro (iOS 26.3.1) par success. App size us Debug sim build par 178 MB.

Kya use hua hai: Xcode 26.3, CocoaPods (136 pods at Phase 1 pod install), Expo prebuild `ios/`.

Kya achieve hua hai: Simulator app repeatedly Metro se chali (Curtain screenshots, Alex QR, MLS self-test PASS, group mention/reply, directory 200).

### Feature: Physical iPhone installation and Keychain / login persistence

Yeh kya karta hai: Personal Team se signed development build real device par chalta hai.

User kaise use karta hai: iPhone 11 Pro par Understage icon; Wi-Fi par Metro `192.168.100.91:8081` aur API `:4000`.

Andar system mein kya hota hai: Device "umer's Iphone (2)", iPhone 11 Pro (iPhone12,3), iOS 26.2.1, CoreDevice `CD0482D9-0E10-5018-B0B9-200BFC370E65`, bundle `com.kvmac.understage`, Personal Team `7SH4DAD2LV`. USB unplug ke baad `devicectl` `transportType: localNetwork`. Entitlements file `ios/Understage/Understage-personal.entitlements` keychain-access-groups use karti hai. Free team 7-day expiry; `aps-environment` sign nahi ho sakta.

Kya use hua hai: `xcrun devicectl` launch `exp+understage://expo-development-client/?url=http://192.168.100.91:8081`.

Kya achieve hua hai: Install + wireless relaunch 19:07:21 PKT success (PID 1401). Session `s_HRuaqu9pf4Z2` restore, no new OTP. Identity fingerprint unchanged. Documents mein koi secure-session file fallback nahi. Yeh Keychain entitlement/`-34018` product-path fix ka device confirmation hai (MLS unsigned Simulator `-34018` alag context tha aur wahan file-protection fallback self-test PASS tak gaya).

### Feature: Encrypted messaging, realtime, receipts, photos, voice

Yeh kya karta hai: Asal 1:1 cipher, live delivery, ticks, aur media decrypt prove karta hai.

User kaise use karta hai: Physical phone se Alex ko messages/media; doosra authenticated account decrypt karta hai.

Andar system mein kya hota hai: Sections 4, 6, 7.

Kya use hua hai: Live server DB inspection (ciphertext only), phone cache, second-account decrypt, ffmpeg/PNG magic checks.

Kya achieve hua hai: 149 ms live delivery; live read ticks ~3 s; 425 ms after reconnect; offline probe catch-up no dupes; photo `m_lHUykMKhNxkR` valid PNG; voice `m_uhp2e7f3zETG` valid m4a 3.46 s delivered+read.

### Feature: Workspace membership and announcements

Yeh kya karta hai: 200-person TEST company join + required ack prove karta hai.

User kaise use karta hai: Invite accept, Stage Management assignment, announcement Acknowledge.

Andar system mein kya hota hai: Section 9–10.

Kya use hua hai: seed script, live API as Alex, `announcement_recipients` rows.

Kya achieve hua hai: Join 19:46:09 PKT; announcement `n_HHPqfNM-ft7_` seen 19:46:14 / acked 19:47:04 PKT; 1/199. Simulator previously 142/200 on older announcement; department directory 8×200; remind API 58/15/43 in 20.4ms.

### Feature: Curtain design verification

Yeh kya karta hai: Approved Curtain identity ko screens par apply karke visually check karta hai.

User kaise use karta hai: App khol kar dock, orb, chats, workspace, ack dekhta hai.

Andar system mein kya hota hai: Theme tokens + StageDock + screen restyles; Chats Home later composition pass.

Kya use hua hai: Simulator screenshots, physical 11 Pro user screenshot of earlier Chats composition, then Wi-Fi reload 10:14 PM PKT.

Kya achieve hua hai: Curtain pass 2: tsc 0, vitest 52/52, Simulator board-match for chats (then-current), chat composer, workspace hero, ack department, orb/switcher. Chats Home composition redesign implement + Simulator functional check + physical reload. Native rebuild in in design passes nahi kiya — Metro Fast Refresh.

---

## UNDERSTAGE — COMPLETE ACHIEVEMENTS SUMMARY

Yeh summary sirf woh jama karti hai jo implement aur (jahan evidence hai) verify ho chuka hai.

**Platform aur architecture.** Understage aaj ek iOS work-chat hai: React Native 0.88.1, Expo SDK 58, TypeScript, Fastify + SQLite + Socket.IO backend, aur ek built-in `/admin` dashboard. App, server, shared crypto, aur admin UI ek hi project mein mil kar kaam karte hain.

**Login aur session.** Phone aur email OTP, hashed identifiers (raw phone store nahi), 10-minute hashed codes, resend purane codes invalidate karta hai, galat code attempt cap, JWT + rotating refresh, Keychain storage, automatic relaunch login, logout revoke. Physical iPhone par OTP login aur session `s_HRuaqu9pf4Z2` ka persistence verified hai.

**Onboarding.** 5 steps: verify, profile/username (Syed Umar / `syed.umar` device par complete), work-identity visibility, working hours, encryption identity (Keychain X25519, fingerprint relaunch par same).

**End-to-end encryption (active path).** TweetNaCl `nacl.box` / `nacl.secretbox`. Server plaintext nahi rakhta. 1:1 messages device-verified. Photos, documents, voice notes isi envelope+blob model par. Groups per-recipient fan-out, 50 member cap, oversized workspace chats par explicit `GROUP_TOO_LARGE_FOR_E2EE`. Safety numbers 60 digits implemented (algorithm tested). Yeh Signal protocol nahi hai — static keys, no ratchet/forward secrecy.

**OpenMLS.** Phase 0: toolchain + iOS target compile + host roundtrip test. Phase 1: UniFFI Expo module linked, Simulator self-test PASS (ciphersuite + Alice↔Bob app messages); unsigned Simulator Keychain `-34018` handled for MLS wrapping key. Phase 2: AS/DS directory code complete, default flag off (`mlsDirectory: false`), production send ab bhi nacl. Directory tests written (9 cases).

**Contacts.** Username search/add device-verified (`@alex.rivera300`). QR create (Simulator Alex My QR), scan/deep-link resolve implemented (phone `POST /invites/resolve 200`). Invite accept idempotent. Phone numbers public API mein nahi.

**Messaging.** Direct chat `c_kthwzfur3ztd` par send/receive, 149 ms live delivery, live read ticks, 425 ms reconnect, offline `/sync` catch-up, zero duplicate ids, outbox + clientId dedupe, preview hydration, title search on Chats Home, replies/mentions data+UI (group Simulator-verified). Typing implemented, is device pass mein observed nahi.

**Media.** Encrypted upload/download/decrypt. Device photo PNG `m_lHUykMKhNxkR` Alex-decrypted. Device voice m4a `m_uhp2e7f3zETG` Alex-decrypted (3.46 s) with receipts.

**Groups.** Create/members/roles/leave, fan-out encryption, 50 cap, mentions/replies/read-by fields, authorization tests passing.

**Workspaces.** Plan-gated create (0/50/200 seats enforced). Hamlet UK Tour 2027 (TEST) `w_M2IFshcmKU84`: 200 members, 8 departments stored as ordinary `users` + `workspace_members` + `departments` (synthetic `h200.*` plus real owner/member). Phone user joined as member in Stage Management. Wrap → read-only + revoked invites + audit, 30-day delete_after mark, server-verified.

**Announcements.** Plaintext by design. Create, audience, require-ack, quiet hours, seen/ack records, department-aware tracker, remind with hold split (58/15/43). Device ack `n_HHPqfNM-ft7_` 19:47:04 PKT, 1/199.

**Calling.** Full signaling+WebRTC+mute/speaker+history implementation in code; phone opened Calls (`GET /calls 200`). Live two-device audio verified nahi. No CallKit on this build. Sealed SDP/ICE; STUN default.

**Hours and notifications.** Shift math, quiet hours, touring/follow-phone-tz, held counters, morning-summary release tested on server. Foreground realtime independent of APNs. Native push hooks present; Personal Team par APNs delivery active nahi.

**Subscriptions.** Crew free, Production £49/50 seats, Company £149/200 seats in code. Server entitlement enforcement tested. JWS verification implemented and unit-tested with local certs; without Apple roots endpoint `501` and grants nothing from `{dev:true}` or raw transactionId.

**Security.** Keychain (device-verified), peppered identifiers, RBAC/workspace isolation, blocks/reports with selected evidence only, rate limits, audit log, encrypted attachments, ciphertext push bodies.

**Admin.** `/admin` dashboard: reports with shared messages, suspend 7/30/permanent + unsuspend, support tickets reply/close, workspace KPIs, audit log. Chrome-verified as `understage.ops`. APIs token or `is_admin` JWT se.

**Curtain UI.** Shared gold/plum design system, Stage Dock, gold orb arc menu, workspace switcher, restyled main screens, then a dedicated Chats Home composition redesign (compact crew strip, non-overlapping pin row, denser list, dock clearance) reloaded on the physical iPhone over Wi-Fi at 10:14 PM PKT (Asia/Karachi).

Yeh Understage aaj yeh hai: ek running iOS development build + local backend jisme theatre crews ke liye encrypted 1:1 chat, media, contacts, 200-person workspace operations (announcements/acks), hours-aware delivery logic, admin moderation, aur Curtain visual identity maujood aur — listed jagahon par — as literally tested.

