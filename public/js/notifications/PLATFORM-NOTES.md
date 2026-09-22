# DM notifications — Electron & Capacitor Android

`notification-manager.js` already makes the *decision* (should this
DM notify?) for every platform, using the same `window.electronAPI`
and `isNativeApp()` conventions the rest of the app uses. What's
below is what still needs to be added on each platform's own side —
neither the Electron main/preload source nor the Capacitor JS
project (the thing `npx cap sync` reads from) was in the files I was
given, only the generated `android/` folder, so I'm not able to
write or test this part directly. This is a spec, not a stand-in for
having done it.

## Electron

The renderer already calls a single function when it needs a
notification:

```js
window.electronAPI.showDmNotification({
  conversationId,  // the peer's user id — what a click should open
  messageId,
  senderId,
  senderName,
  preview,         // already-safe text, e.g. "🎤 Voice message"
});
```

This mirrors the existing `electronAPI.isElectron` /
`getHardwareAcceleration()` / `storeIdentityUnlockKey()` bridge
pattern already used by `core/auth.js` and `settings/settings.js` —
add `showDmNotification` alongside those, not a new bridge.

**Preload** — expose exactly one new method, nothing broader:

```js
// preload.js
contextBridge.exposeInMainWorld('electronAPI', {
  // ...existing methods...
  showDmNotification: (payload) => ipcRenderer.send('dm-notification:show', payload),
});
```

**Main process:**

```js
// main.js
const { Notification } = require('electron');

ipcMain.on('dm-notification:show', (event, payload) => {
  const win = BrowserWindow.fromWebContents(event.sender);

  // If the window is focused, the renderer's own foreground check
  // in notification-manager.js already suppressed this for the
  // active conversation — but a focused window on a *different*
  // conversation, or a different page, still gets here correctly.
  const notification = new Notification({
    title: payload.senderName,
    body: payload.preview,
  });

  notification.on('click', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Reuse the same route the web/Electron renderer already
    // understands — send it back down and let the existing
    // navigate('messages', { id, username }) handle it.
    event.sender.send('dm-notification:clicked', {
      conversationId: payload.conversationId,
      senderName: payload.senderName,
    });
  });

  notification.show();
});
```

Register exactly one `ipcMain.on('dm-notification:show', ...)`
listener at startup (not per-window, not per-renderer-reload) — the
renderer side already only calls `initSocket`/registers its own
listeners once, so as long as this is set up once in `main.js` at
app launch there's no risk of duplicates.

**Renderer** needs one small addition to route the click, next to
where `socket.js`/`dm.js` already live:

```js
window.electronAPI.onDmNotificationClicked?.(({ conversationId, senderName }) => {
  navigate('messages', { id: conversationId, username: senderName });
});
```

with a matching `onDmNotificationClicked` exposed from preload via
`ipcRenderer.on('dm-notification:clicked', ...)`.

No Node integration, no new IPC surface beyond this one channel, no
change to `contextIsolation`.

## Capacitor Android

**What's installed right now:** `@capacitor/android`,
`@capacitor/file-transfer`, `@capacitor/filesystem`. No notification
plugin. `MainActivity.java` is a bare `BridgeActivity` with no
custom code. No `google-services.json` (the app's `build.gradle`
already has a conditional `google-services` block ready for one, but
it isn't present).

**Foreground/background-but-alive case** (app open, JS running, just
not looking at that DM, or app switched to background without being
killed): this can legitimately work today, because Socket.IO is
still connected and `addDmMessage()` still runs. What's missing is a
plugin that can show a *real* Android notification instead of the
Web Notification API (which doesn't produce a system notification on
Android). The right tool is
[`@capacitor/local-notifications`](https://capacitorjs.com/docs/apis/local-notifications) —
it's a "the app decided to show this" API, which matches this case
exactly (the app is alive and has already received and decrypted the
message).

Once that package is added to the Capacitor JS project (I don't have
that project — only the generated native `android/` folder — so this
is `npm install`, not something I can run here) and
`npx cap sync android` is run, `dispatchToCapacitor()` in
`notification-manager.js` becomes:

```js
import { LocalNotifications } from '@capacitor/local-notifications';

async function dispatchToCapacitor(payload) {
  const { display } = await LocalNotifications.checkPermissions();
  if (display !== 'granted') return; // never re-prompt on every message

  await LocalNotifications.schedule({
    notifications: [{
      id: payload.messageId % 2147483647, // must fit a signed 32-bit int
      title: payload.senderName,
      body: payload.preview,
      channelId: 'wire-dm',
      extra: { conversationId: payload.conversationId, senderName: payload.senderName },
    }],
  });
}
```

Permission (Android 13+, `POST_NOTIFICATIONS`) should be requested
once, from the same place the Settings "DM Notifications" toggle
already lives — `LocalNotifications.requestPermissions()` — not on
every incoming message, same as the web path.

A notification channel (`wire-dm`, `IMPORTANCE_DEFAULT` or higher)
needs to be created once, e.g. in `MainActivity.onCreate()`, since
Android 8+ requires one before any notification on that channel can
show.

Click routing: register
`LocalNotifications.addListener('localNotificationActionPerformed', ...)`
once, at app startup, and call `navigate('messages', { id, username })`
from `extra.conversationId` / `extra.senderName` — including on a
cold start, since Capacitor delivers the launch notification's data
through this same listener once the webview is ready, so this one
listener covers both cases without special-casing "was this a cold
start."

**Fully backgrounded or killed app:** this is the case the task spec
is explicit about not faking. `@capacitor/local-notifications` only
fires for something the app *already received* — if Android has
suspended or killed the WebView process, there's no JS running to
receive the Socket.IO event in the first place, local-notification
plugin or not. Making a DM notification arrive to a killed app
requires push infrastructure: `@capacitor/push-notifications` +
Firebase Cloud Messaging, with the Express backend holding device
push tokens and calling FCM's send API whenever
`emitNewDirectMessage()` in `services/socket.service.js` fires (that
function is the one existing choke point for every outgoing DM
event, so it's also the right integration point for a future FCM
call — no new event/plumbing needed on the emit side, just an
additional call alongside the existing `emit()`).

This is not currently present:
- no `google-services.json`,
- no `@capacitor/push-notifications` dependency,
- no device-token table or FCM sender key on the backend.

If that's wanted, it's a real, separate follow-up (Firebase project
setup, a `push_tokens` table + registration endpoint, and calling
FCM from `socket.service.js`) — not something to bolt on silently
inside this notification manager.
