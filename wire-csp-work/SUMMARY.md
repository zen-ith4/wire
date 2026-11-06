# خلاصه کار CSP (Stage 2 و Stage 3) روی شاخه `test`

ریپو: `zen-ith4/wire`، شاخه `test`، از کامیت `07c6651` تا `dc17732`.
هیچ چیزی push نشده. `middleware/csp.js` دست نخورده.

## تگ‌ها
- `csp-stage2-done` -> `7679a1b`
- `csp-stage3-done` -> `dc17732` (HEAD)

## Stage 2
- باگ آواتار: `public/js/ui/avatar.js` حالا listener کلیک را در فاز capture می‌گیرد، پس کلیک روی آواتار در DM picker فقط پروفایل را باز می‌کند.
- `public/js/media/image-viewer.js`: listener تکراری `dragstart` حذف شد.
- `docs/CSP_TODO.md`: وضعیت Stage 2 و توضیح اینکه `actions.js` نام‌های ناشناخته را عمداً بی‌صدا رد می‌کند.
- `tests/csp-handlers-enforced-browser.test.mjs`: تست کلیک واقعی برای composer (حذف پیوست، لغو آپلود، بستن reply)، dm-send، dm-close-new-picker، profile-card-message، dm-back (با element.click چون دکمه روی دسکتاپ مخفی است)، دکمه‌های avatar/banner در Settings (با file chooser و confirm)، Files new-folder، و کلیک آواتار داخل DM picker.

## Stage 3 (تعداد قبل -> بعد)
| فایل | قبل | بعد | روش |
|---|---:|---:|---|
| core/auth.js | 21 | 0 | کلاس در css/pages/login.css |
| settings/settings-render.js | 16 | 0 | کلاس در css/features/settings.css + data-* برای bg preview و swatch |
| settings/admin.js | 3 | 0 | کلاس‌های utilities.css |
| media/video-player.js | 2 | 0 | js-hidden (و 'block' به جای '') |
| media/voice-message.js | 2 | 0 | js-hidden |
| media/audio-player.js | 1 | 0 | js-hidden |
| ui/profile-card.js | 1 | 0 | u-pc-pad |
| wireguard/wireguard.js | 1 | 0 | u-min-w-260 |
| chat/dm.js | 3 style + 1 cssText | 0 | کلاس‌ها، u-offscreen-copy |
| ui/emoji-picker.js | 1 | 0 | data-swatch + CSSOM |
| settings/settings-bubble-gradient.js | 1 | 0 | data-sound-volume |
| settings/settings-message-sounds.js | 1 | 0 | data-sound-volume |
| chat/composer.js | 1 | 0 | data-progress |
| settings/settings-appearance-custom.js | 3 | 0 | data-sound-volume + u-block |
| media/attachments.js | 1 style + 4 cssText | 0 | کلاس‌های wire-dl-progress* + data-aspect |

فایل‌های جدید:
- `public/js/ui/dynamic-vars.js`: مقدارهای پویا را از data-* با CSSOM اعمال می‌کند (اعتبارسنجی hex و محدود کردن عدد). یک MutationObserver هم در `js/core/app.js` نصب می‌کند.
- `public/js/settings/dynamic-style.js`: همین کار برای HTML تنظیمات.
- کلاس‌های جدید در `public/css/utilities.css` (`js-hidden` بدون !important تا JS بتواند display را override کند).

بقیه:
- `tests/csp-static.test.mjs`: `LEGACY_CAPS` حذف شد؛ همه چیز flat صفر است.
- enforced browser test همه viewها را می‌گردد و `style-src` را هم شکست حساب می‌کند.
- `docs/CSP_TODO.md` به یادداشت «CSP-clean» تبدیل شد.
- manifest بعد از هر تغییر public بازسازی شد و `--check` پاس می‌شود.

## تست‌هایی که اجرا شد (Chromium محلی)
- `csp-handlers-enforced-browser.test.mjs`: 2 از 2 پاس (بعد از همه تغییرات Stage 3 به جز کامیت docs).
- `csp-static.test.mjs`: 9 از 10 پاس. تست `CSP header: strict script-src` از قبل هم روی کد اصلی شکست می‌خورد.
- مقایسه pixel صفحه login قبل/بعد: یکسان در web، Electron و native.

## اجرا نشده / باز
- `tests/groups/group-csp-browser.test.mjs` اینجا شکست خورد (`socket did not connect`). `startStaticApp` در تست فقط فایل استاتیک سرو می‌کند و socket.io ندارد. لاگ هیچ CSP refusal ندارد. روی کد اصلی هم این sandbox متفاوت شکست می‌خورد.
- مقایسه screenshot صفحه‌های Settings قبل/بعد انجام نشد.
- تست قطعی برای `open-image-viewer` و دانلود پیوست نوشته نشد.
- `npm run test:groups`، `dm-csp-handlers-enforced-browser`، `csp-confirm-enforced-browser`، `sw-manifest` اجرا نشد.
- نکته: در attachments.js دو مقدار `transition:width:.15s ease` و `transition:opacity:.15s ease` از اول CSS نامعتبر بودند. عیناً در کلاس نگه داشته شدند (رفتار تغییر نمی‌کند). اگر بخواهید جدا درستشان کنید.

## دستورهای WSL به ترتیب
1. `node scripts/build-sw-manifest.mjs --check`
2. `node --test tests/csp-static.test.mjs` (یک شکست قدیمی انتظار می‌رود)
3. `git checkout csp-stage2-done && node --test tests/csp-handlers-enforced-browser.test.mjs`
4. `git checkout test && node --test tests/csp-handlers-enforced-browser.test.mjs`
5. `npm run test:groups` و بقیه تست‌های csp-* و sw-manifest
6. `node --test tests/groups/group-csp-browser.test.mjs`
7. دستی: `CSP_ENFORCE=true npm start` و گشتن login، همه تب‌های settings، admin، پلیرها، اسلایدرهای appearance. کنسول نباید خطای CSP داشته باشد.

اگر 3 سبز و 4 قرمز شد، مشکل در کامیت‌های Stage 3 است. همان کامیت را revert کنید (مثلاً `d2f959e` برای settings، `2585042` برای login، `bb808f8` برای attachments).

## محتوای این zip
- `SUMMARY.md` همین فایل
- `commits.txt` فهرست کامیت‌ها
- `changed-files.txt` مسیر همه فایل‌های تغییرکرده
- `changed-files/` نسخه نهایی همان فایل‌ها با همان مسیرها
- `patches/` یک patch برای هر کامیت (`git am patches/*.patch`)
- `all-changes.diff` کل diff یک‌جا
- `wire-test-csp.bundle` bundle گیت با تگ‌ها (`git fetch wire-test-csp.bundle test:csp-work`)
