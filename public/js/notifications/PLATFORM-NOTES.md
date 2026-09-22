# DM notifications — Electron & Capacitor Android

This supersedes the first draft of this file. That draft was written
before I had the real Electron and Capacitor/Android source and
guessed at two things that turned out to matter:

1. It assumed `@capacitor/local-notifications` would be consumed via
   `import { LocalNotifications } from '@capacitor/local-notifications'`.
   **This project has no JS bundler** — `index.html` loads
   `core/app.js` directly as a native `<script type="module">`, and
   Capacitor's `webDir` is the plain `public` folder, copied as-is.
   `core/server.js`'s existing `isCapacitor()` already reflects this:
   it reads `window.Capacitor` as a global, not an import. Every
   Capacitor plugin here is consumed the same way, via
   `window.Capacitor.Plugins.<PluginName>` — see
   `notification-manager.js`'s `getCapacitorPlugin()`.
2. It assumed the killed-app case would need a custom native
   `FirebaseMessagingService`. It doesn't: sending the FCM message
   with a `notification` block (title/body) makes Android's own OS
   auto-display it whenever the app isn't in the foreground —
   backgrounded *or* killed, no app code involved at all. No native
   Kotlin/Java was written for this.

## What's actually implemented

**Electron** — complete, in `electron.zip`'s `main.js`/`preload.js`:
a single `showDmNotification(payload)` method on the existing
`electronAPI` bridge, one `ipcMain.on('dm-notification:show', ...)`
registered once at module load (validated against `mainWindow.webContents`),
Electron's native `Notification`, and a `dm-notification:clicked`
round trip that focuses/restores the window and hands the target back
to the page via `window.electronAPI.onDmNotificationClicked(...)`
(wired to `navigate('messages', {...})` in `notification-manager.js`).

**Capacitor Android — app alive:**
`notification-manager.js`'s `dispatchToCapacitor()` uses
`window.Capacitor.Plugins.LocalNotifications`, gated on
`document.visibilityState === 'visible'`. That gate is deliberate —
see "Duplicate notifications" below.

**Capacitor Android — backgrounded/killed:**
`services/push.service.js` sends an FCM message with both a
`notification` block (what the OS auto-displays) and a `data` block
(what a tap hands back to the app) whenever `emitNewDirectMessage()`
fires, to every token registered for the recipient. Android displays
it with zero app code when the app isn't foregrounded.

**Token lifecycle:** `push-registration.js` registers for a token via
`PushNotifications.register()` (only after permission is already
granted, or via the one explicit prompt in
`settings-notifications.js`'s toggle), POSTs it to
`/api/me/push-token`, and deregisters it on logout. The backend
(`push_tokens` table, `pushToken.service.js`) upserts by token value,
so a device's token always follows whichever account most recently
registered it — this is what makes "logout, log in as someone else on
the same device" and "token refresh" both correct without special
cases.

**Click routing, cold start included:** `notification-manager.js`'s
`routeNotificationClick()` is shared by the Electron, Local
Notification, and Push Notification tap listeners. If the app isn't
logged in / routed yet (a cold start from a killed app), the target is
held in `pendingNotificationTarget` and delivered once
`markAppReadyForNotificationNavigation()` runs — right after
`initRouter()` in `core/app.js`'s `startApplication()`. Capacitor's
own plugin listener registration already buffers an event fired
before a JS listener existed, and this adds a second buffer on top for
the "listener registered, but no session yet" gap in between.

## Duplicate notifications — what's actually guaranteed vs. best-effort

The spec is explicit that a message must never produce a Local
Notification *and* an FCM notification. Two mechanisms are in play
here, and I want to be precise about which one is load-bearing:

**The real guarantee: `document.visibilityState`.** Android flips this
to `'hidden'` immediately on backgrounding, well before the OS would
ever suspend the WebView's JS. `dispatchToCapacitor()` refuses to run
unless it's `'visible'`. Combined with the fact that Android/FCM
itself never auto-displays a `notification`-block push while the app
*is* foregrounded (standard FCM behavior, not something this app
controls), the two paths are structurally exclusive by app state:
foregrounded → only the Local Notification path can fire; anything
else → only FCM can. This is the mechanism this design actually
depends on.

**Best-effort, not verified: matching notification identifiers.**
Both paths also derive the same value from `messageId`
(`androidNotificationIdForMessage()` client-side,
`androidNotificationTag()` server-side) for the Local Notification's
numeric `id` and the FCM push's `android.notification.tag`. The idea
is that if both ever did fire for the same message (a narrow race
right at the foreground/background transition), Android's
`NotificationManager` would collapse them into one instead of showing
two. I have **not verified** that a Local Notification (posted via
the `@capacitor/local-notifications` plugin's own code path) and an
FCM-auto-displayed notification (posted by Play Services using the
`tag` field) actually share enough of their `(tag, id)` identity for
Android to treat them as the same notification — that depends on
internals of both the plugin and Play Services I don't have visibility
into and can't test without a real device. Treat this as defense in
depth, not as a guarantee, and verify it directly: send a DM to a test
device right as it's being backgrounded and confirm only one
notification appears.

## E2EE tradeoff — the push preview is deliberately generic

`content` on a text DM is end-to-end encrypted — see
`dm.controller.js`'s `sendMessage()`, which stores exactly the
ciphertext JSON the client sent and never decrypts it. The server
genuinely cannot produce a real text preview for a push notification.

- The **live, in-app path** (Socket.IO → `addDmMessage()` →
  `notification-manager.js`) shows the real decrypted preview, because
  the client has already decrypted the message by the time it decides
  to notify.
- The **FCM push** (`push.service.js`'s `buildSafePushPreview()`) can
  only use plaintext DB columns that were never encrypted in the first
  place — `is_voice_message`, `attachment_mime` — for a 🎤/📷/📎-style
  hint. A plain text message gets a generic "Sent you a message".

This is the correct tradeoff given the existing E2EE design, not a
limitation of this implementation — doing better would mean either
sending plaintext through the server (breaking E2EE) or decrypting on
a schedule the server has no key for. If you want a richer push
preview later, that requires a deliberate E2EE redesign (e.g. a
per-device push-encryption key), not a tweak here.

## Everything you still need to do yourself

None of this can be done without your Firebase project and without
running commands against real npm/Capacitor tooling — I don't have
network access in this environment.

### 1. Install the new packages

```bash
npm install firebase-admin
npm install @capacitor/push-notifications@^8 @capacitor/local-notifications@^8
```

(`^8` to match the `@capacitor/core@^8.5.2` already in `package.json` —
let npm resolve the actual current patch versions; I deliberately did
not hand-write version numbers I can't verify from here.)

### 2. Sync the Android project

```bash
npx cap sync android
```

This regenerates `android/capacitor.settings.gradle` and
`android/app/capacitor.build.gradle` (both marked "DO NOT EDIT" —
I left them untouched) to include the two new plugins' native code,
including their own transitive `firebase-messaging` dependency for
`@capacitor/push-notifications`. You don't need to add that dependency
by hand.

### 3. Firebase Console setup (external — nothing here can do this for you)

1. Create a Firebase project (or use an existing one) at
   console.firebase.google.com.
2. Add an Android app with the exact package name from
   `android/app/build.gradle`: **`com.wireapp.arman`**.
3. Download the generated **`google-services.json`** and place it at
   `android/app/google-services.json`. The Gradle wiring for this
   already exists in this project (`android/build.gradle`'s
   `classpath 'com.google.gms:google-services:4.4.4'` and
   `app/build.gradle`'s conditional
   `apply plugin: 'com.google.gms.google-services'` — both were
   already there before this change) and needs no edits.
4. Generate a **service account key** for the backend:
   Project Settings → Service Accounts → "Generate new private key".
   Save the JSON file somewhere **outside the repo** (never commit
   it), and set on the server:
   ```bash
   export GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account.json
   ```
   `services/push.service.js` reads exactly this env var (via
   `firebase-admin`'s standard `applicationDefault()` credential
   lookup) and does nothing — no errors, no crash — if it's unset.

### 4. Rebuild the Android app

```bash
npx cap sync android
cd android && ./gradlew assembleDebug   # or your usual release build
```

### 5. Swap the notification icon

The manifest currently falls back to `@mipmap/ic_launcher` for FCM's
default icon (see the comment in `AndroidManifest.xml`). Android's
status bar wants a dedicated white-on-transparent icon — a full-color
launcher icon renders as a solid white square/dot on Android 5+.
Generate one (Android Studio's Image Asset tool, "Notification Icons"
type) and update the `default_notification_icon` meta-data.

## Testing — what I did and did not verify

I verified every file change by direct code inspection against the
actual project source (there's no server, no emulator, no network in
this environment, so nothing here was run). Specifically **not**
tested, and not claimed to work:

- Whether Android actually collapses a Local Notification and an
  FCM-displayed notification sharing the same derived identifier (see
  "Duplicate notifications" above) — the visibility-state gate is
  what this design actually relies on.
- The full killed-app → tap → cold-start → correct-DM flow end to end
  on a real device.
- Token refresh, multi-device, and logout/re-login behavior under
  real FCM traffic.
- Android 13+ permission prompt behavior on a real device/emulator.

All of these need a real Firebase project, a real device or emulator,
and the install/sync/build steps above completed first.
