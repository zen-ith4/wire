# Manual Test Checklist (Human Only)

> **HUMAN TODO**: Every item below must be verified by a person on real devices.
> The agent cannot run browser/device tests, so nothing here is claimed done.

Print this list and check off each step on each target platform.

---

## Platforms to test

- [ ] Chrome (desktop, latest stable)
- [ ] Firefox (desktop, latest stable)
- [ ] Safari (macOS/iOS, latest)
- [ ] Android APK (built from this branch, `app-debug.apk`)
- [ ] Electron (built from this branch)

---

## Common setup for all platforms

1. Deploy the server (see RELEASE_RUNBOOK.md steps 1–7).
2. Have two test accounts: `alice` and `bob` (different devices/browsers).
3. Create a test group owned by `alice` with `bob` as member.
4. Have a **deactivated** account `dead` (set `is_active = 0` in DB, keep its token).

---

## 1. Login

| Step | Expected |
|------|----------|
| Open the app, enter username/password | Login succeeds, lands on conversations list |
| Register a new account | Registration succeeds, forced password change if admin-created |
| Wrong password | Shows "Invalid credentials", no lockout UI regression |
| Login with deactivated account (`dead`) | Fails with 401 / "Account deactivated" |

☐ Chrome ☐ Firefox ☐ Safari ☐ APK ☐ Electron

---

## 2. DM text + attachment

| Step | Expected |
|------|----------|
| `alice` → `bob`: send text message | Appears instantly on both sides, decrypts |
| `alice` → `bob`: attach image (≤ cap) | Uploads, thumbnail shows, download works |
| `alice` → `bob`: attach file exactly at cap (1 MiB test) | Accepted (200), file downloadable |
| `alice` → `bob`: attach file cap+1 | Refused (400 "Upload failed"), no orphan file on server |
| `bob` downloads attachment | File saves, content byte-identical to original |
| Reload both browsers, re-open DM | History intact, attachments still download |

☐ Chrome ☐ Firefox ☐ Safari ☐ APK ☐ Electron

---

## 3. Group message (UI flag OFF)

> `GROUP_ATTACHMENTS_UI_ENABLED=false` in `public/js/chat/group-attachments-flag.js`

| Step | Expected |
|------|----------|
| Open group chat | No attachment button / paperclip in composer |
| Send text message in group | Delivers to all members, decrypts |
| Try to send attachment via any hidden path | Not possible through UI (flag off) |

☐ Chrome ☐ Firefox ☐ Safari ☐ APK ☐ Electron

---

## 4. APK update flow

### 4a. Matching hash (update allowed)

1. Build APK from this branch (`app-debug.apk`).
2. Deploy server **with that exact APK** at `APK_PATH`.
3. Install OLD APK on device (from previous release).
4. Open app → Settings → Check for updates.
5. **Expected:** Update prompt appears, download starts, install succeeds, new version runs.

### 4b. Mismatched hash (update refused)

1. Build APK from this branch.
2. Deploy server with a DIFFERENT APK (or no APK) — e.g., rename the file so hash differs.
3. Install THIS branch's APK on device.
4. Open app → Settings → Check for updates.
5. **Expected:** Update check fails / shows "Update unavailable: server hash mismatch" — **no install attempt**.

☐ APK only

---

## 5. CORS from Capacitor / Electron origins

| Step | Expected |
|------|----------|
| Open Electron build, login | `Origin: capacitor://localhost` or `file://` accepted, no CORS error |
| Open APK (WebView), login | `Origin: capacitor://localhost` accepted |
| Make API calls (DM send, group list) | All succeed, no "CORS missing allow origin" |
| `credentials: false` enforced | Cookies not sent cross-origin; auth only via `Authorization` header |

☐ Electron ☐ APK

---

## 6. Deactivated user → media = 401

1. Use `dead`'s token (from setup).
2. Hit a DM attachment URL: `GET /api/dm/attachments/<msgId>`.
3. **Expected:** `401 Unauthorized` (was 200 before this merge).
4. Hit a group attachment URL (if any): `GET /api/groups/<gid>/attachments/<msgId>`.
5. **Expected:** `401 Unauthorized`.

☐ Chrome ☐ Firefox ☐ Safari ☐ APK ☐ Electron

---

## 7. Group voice recording/playback (flag-on dev copy)

> The repo flag `MEDIA_STREAM_ENABLED=false` in `public/sw.js`. To test voice:
> 1. Copy the repo to a temp dir: `cp -r /path/to/repo /tmp/wire-voice-test`
> 2. Edit `public/sw.js`: change `const MEDIA_STREAM_ENABLED = false` → `true`
> 3. Edit `public/js/chat/group-attachments-flag.js`: change `GROUP_ATTACHMENTS_UI_ENABLED = false` → `true`
> 4. Build & run server from that copy (different port).
> 5. Test on Chrome + Firefox (desktop) — mobile WebRTC support varies.

| Step | Expected |
|------|----------|
| Open group chat, hold voice button | Records audio, shows waveform |
| Release → sends voice message | Appears in thread, play button works |
| Play voice message | Audio plays, seeks, downloads |
| Other group member receives | Plays on their device |
| Reload, play again | Still works |

☐ Chrome ☐ Firefox

---

## 8. My Files (Drive) upload

| Step | Expected |
|------|----------|
| Open Files / Drive tab | Shows default folder |
| Upload file ≤ cap | Accepted, appears in list |
| Upload file cap+1 | Refused (400), no orphan |
| Download uploaded file | Byte-identical |

☐ Chrome ☐ Firefox ☐ Safari ☐ Electron

---

## 9. Avatar / Banner upload

| Step | Expected |
|------|----------|
| Settings → change avatar (image ≤ cap) | Accepted, shows in header |
| Settings → change banner (image ≤ cap) | Accepted, shows in header |
| Try cap+1 image | Refused (400) |

☐ Chrome ☐ Firefox ☐ Safari ☐ Electron

---

## 10. Admin UI: Add user (browser)

| Step | Expected |
|------|----------|
| Login as admin, open Admin → Users → Add user | Form renders |
| Enter username, email, temp password ≥ 12 chars | User created, temp password shown |
| Temp password < 12 chars | Refused with message |
| New user logs in with temp password | Forced password change, then normal session |

☐ Chrome ☐ Firefox

---

## Sign-off

| Platform | Tester | Date | All checks passed? |
|----------|--------|------|---------------------|
| Chrome | | | ☐ |
| Firefox | | | ☐ |
| Safari | | | ☐ |
| Android APK | | | ☐ |
| Electron | | | ☐ |

**No merge until all five columns are checked.**