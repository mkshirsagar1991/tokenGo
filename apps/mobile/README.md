# TokenGo mobile apps

A Dart pub workspace: `packages/tokengo_core` (API client, models, repositories, design system, shared sign-in) +
`customer` (TokenGo) + `provider` (TokenGo Business). Architecture and the rules every screen follows: [ADR-0014](../../docs/adr/0014-mobile-apps.md).

## Run against the local API
1. Start the stack (`pnpm db:up`, then the API and worker — see the root README). The API listens on `http://localhost:3000`.
2. Start an Android emulator. It reaches your machine at `10.0.2.2`, which is the apps' default `API_BASE_URL`.
3. From `customer/` or `provider/`:

```bash
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:3000/api/v1
# optional: --dart-define=MAP_TILE_URL=https://tile.example/{z}/{x}/{y}.png
```

Build an APK: `flutter build apk --debug` (cleartext HTTP to the dev host is allowed in **debug** builds only).

### Install on a real phone (same Wi-Fi as this PC)
The API address is compiled into the app, and `10.0.2.2` only exists inside the emulator. For a phone, build with this PC's address:

```powershell
.\apps\mobile\tool\build-apks.ps1        # finds this PC's address; writes apk\TokenGo-customer-arm64.apk and apk\TokenGo-business-arm64.apk (+ arm32 variants)
.\apps\mobile\tool\build-apks.ps1 -ApiBaseUrl http://192.168.1.20:3000/api/v1   # or name the address yourself
.\apps\mobile\tool\build-apks.ps1 -Mode debug    # the old 200+ MB debug build, only for hot reload / breakpoints on a phone
```
- **Small by default (about 20 MB per app).** The script builds the **profile** mode (optimized AOT, one APK per CPU type, debug-key signed). Use the `arm64` APK; only if Android says "App not installed" on an old/32-bit phone use the `arm32` one.
- **Profile builds are the internal test build.** `src/profile/AndroidManifest.xml` allows plain `http://` (like the debug manifest); **release** builds keep Android's secure default (https only), so a release APK needs an HTTPS API, which does not exist yet. Release signing, store listings, push (Firebase) and a production map-tile provider are also not set up. Never hand a profile build to the public.
- The phone must be on the **same network** as the PC, the API (`:3000`) and worker must be running, and Windows Firewall must allow Node on that network (check first: open `http://<pc-address>:3000/api/v1/health/ready` in the phone's browser). Wi-Fi "client isolation" blocks this.
- If the PC's address changes (DHCP), the apps stop connecting: run the script again and reinstall, or give the PC a fixed address.
- Allow "install unknown apps" for whatever you use to open the file. Login codes are not sent by SMS: read them from the API log.

**Provider app (TokenGo Business).** A brand-new number can register a business, add a location, services, hours and staff, and submit
it for review, all from the app (Today shows the review status and a setup checklist; the **Business** tab manages everything afterwards).
Approve the business in the admin portal (**Providers**, open it, **Approve**; see the root README); the app notices within 30 s. Staff are invited by mobile number and accept in their own app. Arrival is verified by
scanning the customer's QR (camera permission asked only when tapped) or by the 6-digit code.

**Dev sign-in.** OTP codes are not sent by SMS in development; the API prints them (`[DEV SMS] OTP for +91 ••••• ••021: 123456`).
After `pnpm seed:dev`: customers `9000000021`–`23` (₹2,000 of dev test funds each), salon owners `9000000011`–`13`.
Codes are limited to one per 30 s per number.

## Test
```bash
cd packages/tokengo_core && flutter test   # models, API client, repositories, live-contract
cd customer && flutter test                # top-up money rules, sign-in flow, routing guards
cd provider && flutter test                # booking actions + QR arrival, schedule/dashboard, sign-in, new-owner onboarding, hours/rules/services/staff
flutter analyze                            # in each package
```

## Contract tests against real server output
`packages/tokengo_core/test/live_contract_test.dart` runs every parser the apps use over **real responses captured from the dev API**
(`test/fixtures/live/*.json`, including the provider-setup `setup_*.json` captured with `CAPTURE_SETUP_WRITES=1`). Hand-written fixtures only prove a model agrees with its author's assumption — the wallet model once
compared `account` with `CUSTOMER_HELD` while the server sends `HELD`, and every hand-written test passed. After an API change,
re-capture with `tool/capture_fixtures.mjs` (usage in its header) and re-run the tests.

## WhatsApp login-code autofill (Android)
When the login code arrives on WhatsApp the apps fill it in and sign in by themselves (Meta **zero-tap**; **one-tap** "Autofill" button as the
first fallback; WhatsApp's own "Copy code" button when neither is possible, e.g. iPhone, no WhatsApp on this phone, or the signature does not match).
- **How:** the app tells WhatsApp it is waiting (a *handshake*, via Meta's OTP Android SDK) just before the server is asked for a code
  (`WhatsAppOtpAutofill`, `packages/tokengo_core/lib/src/util/whatsapp_otp_autofill.dart`); WhatsApp then hands the code to a receiver/activity
  (`packages/tokengo_core/native/android/…`, ONE copy compiled into both apps), and the code screen submits it like a typed code.
  The code is held in memory only, for at most 10 minutes, used once, never logged. The server is unchanged: the template message already carries the code twice.
- **Template (WhatsApp Manager):** type zero-tap, with **both** packages and their **App signature hash** under App setup:
  `com.tokengo.tokengo_customer` and `com.tokengo.tokengo_provider`. The hash (11 characters) is made from the package name and the key the APK is
  signed with, so it is **different per signing key**: the test APKs use the debug key of the PC that built them, a release build will use another
  (add it as another row, up to 5). Print it with the SHA-256 recipe in Google's SMS Retriever docs ("Compute your app's hash string").
- **Debugging:** WhatsApp reports why it did not autofill as a broadcast (`com.whatsapp.otp.OTP_ERROR`; e.g. `incorrect_signature_hash`,
  `missing_handshake_or_disorder`, `otp_request_expired`, notifications off for WhatsApp). Meta deprecates the older PendingIntent handshake on
  **2026-10-15**; this code already uses the replacement SDK.
- **Fallbacks (2026-10-30):** the code screen asks the native side once a second (so a missed "code arrived" notification cannot leave the code unclaimed), reads a 6-digit code from the clipboard when the app comes back to the front (WhatsApp's "Copy code" button), and has a **Paste code** button. The Android side keeps working when the activity/engine is re-created, and logs WHY WhatsApp did not autofill (never the code): `adb logcat -s TokenGoWhatsAppOtp`.
- **Needs a phone to prove:** the unit/widget tests cover the Dart side only; WhatsApp's side can only be checked on a real Android phone that has WhatsApp
  and receives the message on the same phone.

## Push notifications and automatic refresh (Android)
The server already sends a push for every booking, wallet, payout and review event (`apps/api` notifications module, FCM). The apps:
- **register this phone** (`POST /devices`) after sign-in, on every start, and when Firebase changes the address; **unregister** it on sign-out (`DeviceRegistration`, `AuthRepository.signOut`);
- **refresh by themselves**: a push that arrives while the app is open refreshes bookings, wallet and earnings (`core/push.dart` in each app) and shows a banner with **View**; coming back to the app refreshes too; the old 15 s / 30 s polling stays as a safety net;
- **open the right screen** when a notification is tapped (a booking, the wallet, the bank-account screen), including when the tap started the app from closed (`PushListener`).
- Android: channel `tokengo_default` (high importance, created at start), the status-bar symbol `ic_stat_tokengo`, and the Android 13 notification permission (asked once, after sign-in).

**Switching it on needs one file per app, from the Firebase console** (Project settings > Your apps > Add app > Android; package names `com.tokengo.tokengo_customer` and `com.tokengo.tokengo_provider`):
`customer/android/app/google-services.json` and `provider/android/app/google-services.json`. Without them the apps build and run exactly as before, with no push (the Google Services Gradle plugin is applied only when the file exists). The API side is `PUSH_PROVIDER=fcm`, `FCM_PROJECT_ID`, `FCM_SERVICE_ACCOUNT_JSON_B64` in `apps/api/.env`, and its Firebase project must be the SAME project the two google-services.json files come from, or the server cannot deliver to the phones.
Test on a real phone: sign in, put the app in the background, then change a booking from the other app or the admin portal.

## Windows + JDK notes (this repo's dev machine)
If Gradle fails with `Unable to establish loopback connection`, point `TEMP`/`TMP` at a folder on a drive that accepts Unix-domain
sockets for that process (e.g. `$env:TEMP='E:\tools\javatmp'; $env:TMP='E:\tools\javatmp'` in PowerShell) and run `gradlew --stop`.
The Android projects pin NDK 27.1.12297006 and disable Kotlin incremental compilation (project on `E:`, pub cache on `C:`); see ADR-0014.

## Razorpay
Top-up opens Razorpay Checkout for the order the **server** created, in **test mode** (test keys live only in `apps/api/.env`).
The app never credits anything itself: it asks the server to verify with Razorpay. Live keys are refused by the API at startup.

## iPhone (no Apple Developer account)
iOS apps can only be built on macOS, so they are built in the cloud: `.github/workflows/ios-unsigned.yml` (GitHub Actions, run it by hand) produces an **unsigned**
`.ipa` per app. Put the repository on GitHub, run the workflow, download the two artifacts, then install them with **Sideloadly** (or AltStore) on Windows/Mac using a
**free Apple ID**. Limits of a free Apple ID: the app stops opening after **7 days** (re-install it), at most 3 apps at a time, and no push notifications.
- `Info.plist` allows plain `http://` ONLY for the test server `52.25.145.254` (remove that exception when the API has HTTPS); the location (both apps) and camera (business app, QR scan) permission texts are set.
- On iPhone the WhatsApp login-code autofill does not exist (Android only): tap **Copy code** in WhatsApp, then **Paste code** in the app.
- Push (Firebase) is Android-only in the code, so it stays off on iPhone. Nothing here has been run on an iPhone yet.
