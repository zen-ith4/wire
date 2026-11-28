# گزارش نهایی — electron-bundled-spike (فاز ۲)

**شاخه:** `electron-bundled-spike` (فقط fast-forward، بدون force/merge/تغییر تاریخچه، هرگز `main`)
**کمیل‌شده:** `6d82c68` (fix(electron-client): harden remember-me, fix E2E reliability, WIRE_E2E URL logging)
**تاریخ:** ۲۸ آبان ۱۴۰۵ (۲۰۲۶-۱۱-۲۸)

---

## ۱. خلاصه تست‌های اجرا شده

تست‌های واحد (`node --test "tests/*.test.mjs"`): **۴۰ مورد برآورده، ۰ رد.**

تست‌های التواصل-ranu (E2E) با Electron واقعی:

### sessions A–C با انبار (keyring) — سه Run متوالی
هر سه Run همین نتیجه را دادند:

```
E2E: 54 passed / 55 total, 0 failed, 1 skipped
```

| Run | Exit code | نتیجه |
|-----|-----------|--------|
| ۱/۳ | ۰ | موفق |
| ۲/۳ | ۰ | موفق |
| ۳/۳ | ۰ | موفق |

در هر Run **۵۴ مورد PASS، ۰ مورد FAIL، ۱ مورد SKIP**:
- `notification:shown` به دلیل عدم-presence دیمون نوتیفیکیشن در محیط تست SKIP شد (با دلیل، هرگز PASS نشده است؛ trusted-sender IPC از طریق `dm-notification-accepted` ثابت شد).

### session D (بدون انبار، `--password-store=basic`)

```
E2E: 7 passed / 7 total, 0 failed, 0 skipped
```

Exit code: **۰**

---

## ۲. backend تشخیص‌شده storage

- با `--password-store=gnome-libsecret` (انبار زائلة، HOME موقت): `gnome_libsecret`
- با `--password-store=basic` (بدون انبار): `basic_text`

کلیه compare‌ها با متغیر محیطی `E2E_PASSWORD_STORE` انجام شد و بله با backend دایلمان مطابقت داشت.

---

## ۳. findingها و 작업های انجام‌شده

### (۱) remember-me بدون انبار / security-policy.js
- `isUnprotectedStorageBackend`، `hasV10Prefix`، `pruneUnprotectedRecords` در `electron-client/security-policy.js` اضافه شدند (pure helpers، unit-testable بدون Electron).
- `identity:store-unlock-key` روی لینوکس وقتی backend `basic_text` یا `unknown` است، به صورت `{ success: false, error: 'OS-level secure storage is not available on this system.' }` بازمی‌گرداند و چیزی نوشته نمی‌شود.
- `identity:get-unlock-key` همان مقدار null را برمی‌گرداند.
- هر記録ی با prefix `v10` (رمز عبور شده با رمز عبور عمومی Chromium) در存 stored شده است یا یافت می‌شود، پاک می‌شود (prune در store و get).
- دومین لایه دفاع: هر ciphertext با prefix `v10` در لینوکس هرگز persist نمی‌شود حتی اگر بررسی backend pasar شود.
- Fallback sync حذف شد؛ async فقط.
- Re-encrypt شکست-\(\rightarrow\) کد decrypt‌شده بازمی‌گردنده و رکورد قدیمی نگه‌داشته می‌شود (KEY not lost).
- وب-UI (`public/js/core/auth.js`) تغییر نیافت: `persistUnlockKey` نتیجه store را نادیده می‌گیرد و `attemptAutoUnlock` کلید 없 pendants را FALSE می‌گرداند (تست 계약 در `tests/unlock-key-ui-contract.test.mjs`).

### (۲) حذف claim نادرست sync/async
- پاراگراف در `docs/ELECTRON_BUNDLED_CLIENT_DESIGN.md` تصحیح شد: sync و async **interoperable** هستند وقتی یک entry keyring همان‌نام برنامه را داشته باشند؛ الاختلاف قبلی به خاطر `app.setName()` در seed بود که entry متفاوتی می‌ساخت.
- seed (`e2e/seed-legacy-key.js`) فقط از API sync (`isEncryptionAvailable` + `encryptString`) استفاده می‌کند، `app.setName()` را صدا نمی‌زنند، نام برنامه را log می‌کند، try/catch دارد، watchdog ۲۰s دارد و **همیشه خارج می‌شود**.
- نام برنامه seed (`[seed] app-name=Electron`) و نام برنامه در دست تست (`[e2e] app-name=Electron`) مقایسه شد و یکسان است.

### (۳) E2E reliability
- هر spawned process (test-server, Electron, seed) timeout سخت دارد (`armTimeout` / `waitForExit` / watchdog global ۲۰دقیقه).
- `e2e/run-with-keyring.sh`: dbus-daemon Session خصوصی، gnome-keyring زائلة بازشده، HOME/XDG_RUNTIME_DIR موقت، `--password-store=gnome-libsecret`، `--ozone-platform=x11`، `--use-fake-device-for-media-stream`، پاکسازی trap.
- `e2e/run-no-keyring.sh`: همان بدون انبار، `--password-store=basic`.
- `permission:audio-granted-in-main`: request OR check handler granting akzeptiert می‌شود (Chromium ممکن است request handler را رد کند اگر check handler granting کرده باشد).
- `permission:video` هرگز授权 نمی‌شود.
- Nوتیکیشن: `dm-notification-accepted` بعد از اعتبارسنجی sender/payload log می‌شود؛ اگر `Notification.isSupported()` False باشد → `dm-notification-unsupported` و SKIP با دلیل، هرگز PASS؛ `dm-notification-created`/`dm-notification-failed` حول constructor/show.
- وِندوز Open: scheme+origin log می‌شود (`window-open scheme=smb origin=...`)، هرگز openExternal صدا نمی‌زند.
- `--use-fake-device-for-media-stream` برای microphone deterministic.

### (۴) WIRE_E2E logging
- `e2eLoggingEnabled()` مستلزم `WIRE_E2E === '1'` **و** `!app.isPackaged` است.
- `describeUrl()` فقط scheme و origin را log می‌کند (URL کامل هرگز log نمی‌شود).
- `openExternalSafely` و `setWindowOpenHandler` از `e2eLog` استفاده می‌کنند.

---

## ۴. بررسی رمز diffusion (diff check)
`git diff --check`чисто است؛ هیچ رمز، کلید privat، یا secret در diff جدید نیست. `FINAL_REPORT.md` فقط dummy/E2E values دارد.

---

## ۵. آنچه هنوز تأیید نشده است (unverified)

- توزیع است]\)]关闭 suite روی macOS/Windows tentsd نیازمند ElectroN الحقيقي است؛ فقط لینوکس آزمایش شد.
- مسیر Re-encrypt failure実务اً trigger نشد (тест unit وجود دارد اما مسیر electron真的 failure به صورت مصنوعی inject نشده است.
- push به origin/electron-bundled-spike هنوز انجام نشده (مرحله بعدی).
- اعتبارسنجی نهایی با `git ls-remote` بعد از push.

---

## ۶. فایل‌های تغییر یافته/جدید

- `docs/ELECTRON_BUNDLED_CLIENT_DESIGN.md` (تصحیح paragraph،довcl basic_text/v10)
- `electron-client/main.js` (safeStorage handlers، logging، e2e helpers)
- `electron-client/security-policy.js` (helpers جدید + لیست مجاز permission)
- `electron-client/e2e/run-e2e-test.js` (timeouts، session D، app-name check، v10 check)
- `electron-client/e2e/seed-legacy-key.js` (sync-only seed + watchdog)
- `electron-client/e2e/no-keyring-checks.js` (جدید)
- `electron-client/e2e/run-with-keyring.sh` (جدید)
- `electron-client/e2e/run-no-keyring.sh` (جدید)
- `electron-client/e2e/page-checks.js` (timeout per IPC call)
- `electron-client/tests/security-policy.test.mjs` (تست‌های واحد برای helpere جدید)
- `electron-client/tests/unlock-key-ui-contract.test.mjs` (جدید)

---

## ۷. مراحل بعدی (باقی‌مانده)

1. `git push origin electron-bundled-spike` (fast-forward)
2. `git ls-remote origin electron-bundled-spike` برای تایید commit `6d82c68`
3. این گزارش را نهایی و commit کنید.
