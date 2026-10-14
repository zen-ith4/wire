<!--
  ARCHIVAL COPY - the original lives uncommitted in the `main` checkout at
  D:\WIre (written 2026-10-12) and belongs to its author. Nothing below the
  separator has been edited; only this header was added.

  SCOPE: this review covers `main` = 0593a6f. It does NOT describe wire-final-8.
  Before acting on any item, re-check it against the tree you are working on:
  several entries marked "open" below have since been fixed on wire-final-8
  (a stale service-worker manifest had no test, the repo was not locked to LF,
  and four dm-attachments tests failed on Windows), and the group Sender-Key fix
  in 3.1 has been ported onto wire-final-8.
-->

---

# Wire — بازبینی و مشکلات شناسایی‌شده

تاریخ: ۱۲ اکتبر ۲۰۲۶ · وضعیت: `main` = `0593a6f` · همه‌ی موارد زیر روی همین کد بررسی شده‌اند

این سند جمع‌بندی همه‌ی مشکلاتی است که در جریان ادغام laneهای A/B/C و بازبینی بک‌اند پیدا شدند.
موارد با وضعیت **«رفع شد»** در همین نشست اصلاح و commit شده‌اند؛ بقیه هنوز باز هستند.

---

## خلاصه

| دسته | باز | رفع‌شده |
|---|---|---|
| امنیتی | ۷ | ۰ |
| زیرساخت / build | ۵ | ۱ |
| باگ رفتاری | ۱ | ۱ |
| کیفیت تست | ۸ | ۰ |
| کیفیت فرایند | ۳ | ۰ |

مهم‌ترین یافته: **manifest سرویس‌ورکر از commit `0a267a5` بازسازی نشده بود** و هیچ تستی هم آن را چک نمی‌کرد. این باعث شده بود چند merge پشت‌سرهم بدون آنکه کد جدید واقعاً به مرورگر برسد منتشر شوند.

---

# ۱. امنیتی

## ۱.۱ عدم تقارن در محافظت از مسیر فایل — **باز**

`controllers/files.controller.js`

| مسیر | محافظت |
|---|---|
| `listFiles` :112 | فقط لغوی ❌ |
| `downloadFile` :202, :210 | فقط لغوی ❌ |
| `previewFile` :247, :255 | فقط لغوی ❌ |
| `getFileMediaToken` / `streamFile` :412 | `resolveRegularFile` ✅ |
| `deleteEntry` | `resolveDeletableEntry` ✅ |

سه هندلر اول با `safeSubPath()` کار می‌کنند که فقط لغوی است و سپس `res.download`/`sendFile` می‌زنند که **سیم‌لینک را دنبال می‌کند**. همان فایل (`utils/safePath.js:19-20`) صریحاً هشدار می‌دهد که `safeSubPath` «در مورد سیم‌لینک هیچ نمی‌گوید».

**اثر:** محدود. از طریق HTTP نمی‌توان سیم‌لینک ساخت، پس نیاز به سیم‌لینک موجود روی دیسک دارد. ریموت اکسپلویت نیست، ولی دقیقاً همان شکافی است که یک سیم‌لینک محلی را به خواندن فایل دلخوراه تبدیل می‌کند.

**راه‌حل:** انتقال `downloadFile` و `previewFile` به `resolveRegularFile` — همان الگویی که دو هندلر دیگر همان فایل استفاده می‌کنند.

## ۱.۲ پذیرش نام چندبخشی و dotfile — **باز**

`controllers/files.controller.js:199, 210, 244, 255`

`file` مستقیم به `safeSubPath` می‌رود، پس `file=.env` یا `file=a/b/c.txt` پذیرفته می‌شود. `resolveRegularFile` عمداً جداکننده، NUL و سگمنت مخفی را رد می‌کند. حتی `res.download(resolved, file)` همان مقدار خام چندبخشی را به‌عنوان نام فایل دانلود به کار می‌برد.

## ۱.۳ `config/socket.js` فقط تصادفی امن است — **باز**

`config/socket.js:45` از `jwt.verify` خام استفاده می‌کند، نه `verifySessionToken` — برخلاف `authenticate.js` و `mediaAuth.js` که هر دو دقیقاً به همین دلیل قبلاً اصلاح شدند.

الان امن است **فقط تصادفی**: توکن‌های media کلید `sub` دارن نه `id`، و چک `user.id == null` (خط ۴۷) تصادفاً آن‌ها را رد می‌کند. اگر روزی `signMediaToken` طوری تغییر کند که `id` هم داشته باشد، یک توکن ۹۰ ثانیه‌ایِ یک فایل، توکن نشست کامل می‌شود.

## ۱.۴ دو socket هندلر گروه چک عضویت را رد می‌کنند — **باز**

`sockets/group.socket.js:44-50` (`group:leave-room`) و `:65-75` (`group:stop-typing`)

`group:join` و `group:typing` هر دو `isAuthorized()` صدا می‌زنند؛ این دو نمی‌کنند. عملاً بی‌اثر است چون حذف عضو `removeUserFromGroupRoom` را صدا می‌زند، ولی ناهماهنگی است.

## ۱.۵ مجوز بعد از آپلود بررسی می‌شود — **باز**

`controllers/files.controller.js:144-166`

`fileUpload.single('file')` اول در `TMP_UPLOAD_DIR` می‌نویسد، بعد `uploadFile` تازه `folderId` و `can_write` را چک می‌کند. تمیزکاری درست انجام می‌شود، ولی هر کاربر احراز‌شده می‌تواند تا `UPLOAD_MAX_MB` روی دیسک بنویسد برای پوشه‌ای که دسترسی ندارد.

## ۱.۶ `dm:typing` هر `recipient_id` را قبول می‌کند — **باز**

`sockets/dm.socket.js:16-37`

هیچ بررسی وجود/عضویت گفتگو نیست — فقط `parseRecipientId` که یک عدد صحیح می‌خواهد. هر کاربر احراز‌شده می‌تواند رویداد `dm:typing` به اتاق `user:<id>` هر کاربری بفرستد. فقط اسپوف UI، نه دسترسی به داده.

## ۱.۷ پوشه‌های ادمین غیرقابل‌مدیریت‌اند — **باز**

`controllers/admin.controller.js:216-220`

`createFolderService` با `owner_id = null` صدا زده می‌شود. در نتیجه `deleteEntry` (که `folder.owner_id === req.user.id` را می‌خواهد) همیشه رد می‌کند، و `requireOwnedFolder` در `shareLink.controller.js:107` همیشه شکست می‌خورد — یعنی لینک اشتراک هرگز ساخته نمی‌شود.

## ۱.۸ نشتی مسیر مطلق فایل‌سیستم — **باز**

`controllers/share.controller.js:95` → `res.json({ id, display_name, path: folderPath })`

فقط به owner خودش برمی‌گردد، ولی چیدمان دایرکتوری سرور را افشا می‌کند.

---

# ۲. زیرساخت و build

## ۲.۱ manifest سرویس‌ورکر ۵ merge را از دست داد — **رفع شد**

**مهم‌ترین یافته‌ی این بازبینی.**

`public/sw-manifest.js` آخرین بار در commit `0a267a5` بازسازی شده. نسخه در همه‌ی کامیت‌های بعدی یکسان مانده بود:

```
41ba053 : "version": "790a139236c2"
2bb1f6d : "version": "790a139236c2"
68aa770 : "version": "790a139236c2"
5f9a0f0 : "version": "790a139236c2"
```

و `sw.js:100`:

```js
const existing = await cache.match(url);
if (existing) return;      // یک‌بار کش شد، دیگر هرگز دانلود نمی‌شود
```

پس `wire-shell-790a139236c2` هرگز تازه نشد. نتیجه:

| دسته | منبع |
|---|---|
| ۴۵ فایل موجود در manifest | از **کش کهنه** سرو می‌شدند |
| ۶ فایل جدید غایب از manifest | از **شبکه** (تازه) |

یعنی ماژول‌های رمزنگاری جدید از شبکه، ولی نسخه‌های قدیمی ماژول‌های فراخواننده‌شان از کش. از جمله `crypto/groups/sender-key.js` که نسخه‌ی کش‌شده‌اش اصلاً `signKey` ندارد → `getMySenderKey()` برمی‌گرداند `null`.

**همین باعث باگی بود که کاربر گزارش داد** (بخش ۳).

**رفع:** بازسازی، `790a139236c2` → `6fe16850b4ce`. `--check` الان pass می‌شود.

## ۲.۲ هیچ تستی manifest را چک نمی‌کند — **باز**

`scripts/build-sw-manifest.mjs --check` وجود دارد و دقیقاً همین مشکل را تشخیص می‌دهد — ولی هیچ‌جا صدا زده نمی‌شود. نه در `package.json`، نه در هیچ فایل تستی. تا وقتی تست نداشته باشد، این دوباره اتفاق می‌افتد.

**پیشنهاد:** یک تست کوچک که `--check` را اجرا کند و exit 1 را fail بگیرد.

## ۲.۳ نبود `.gitattributes` → manifest وابسته به محیط — **باز**

`build-sw-manifest.mjs:49` هش را از **بایت‌های خام** می‌گیرد:

```js
rev: createHash('sha256').update(readFileSync(join(publicDir, url))).digest('hex')
```

ولی `core.autocrlf=true` است و `.gitattributes` وجود ندارد. سه فایل در working copy با LF و در checkout تازه با CRLF هستند:

```
js/core/viewport-fix.js              LF 1350 bytes  |  CRLF 1377 bytes
js/crypto/groups/local-wrap-key.js   LF 4479 bytes  |  CRLF 4610 bytes
js/crypto/keys/unlock-key-store.js   LF 3044 bytes  |  CRLF 3185 bytes
```

یعنی manifest برای کامپیوتر توسعه‌دهنده درست است و برای سرور نیست.

**تشدید:** `sw.js` هنگام نصب هش هر فایل را راستی‌آزمایی می‌کند و در صورت عدم تطابق `throw` می‌کند. پس روی سرور، **کل نصب service worker شکست می‌خورد** — نه فقط سه فایل.

**راه‌حل:** افزودن `.gitattributes` با `* text=auto eol=lf`، سپس `git add --renormalize .` و بازسازی manifest روی خروجی نرمال‌شده.

## ۲.۴ اولین push همیشه fail می‌شود — **باز (غیرکد)**

اولین `git push` با `Failed to authenticate user` رد می‌شود، دومی موفق است. رفتار Git Credential Manager است: تلاش اول با credential کهنه رد می‌شود.

## ۲.۵ remote روی HTTPplain — **باز (غیرکد)**

`http://10.10.10.1:3001/arman/WIre.git` — بدون TLS. نام کاربری و token هنگام push رمزنگاری‌نشده روی شبکه می‌روند.

Git هشدار می‌دهد: `use of unencrypted HTTP remote URLs is not recommended`.

---

# ۳. باگ رفتاری

## ۳.۱ ارسال پیام گروه با «No Sender Key» شکست می‌خورد — **رفع شد**

**گزارش کاربر:** اولین پیام در گروه fail می‌شد و فقط refresh درست می‌کرد.

سه لایه داشت:

**الف) مسیر ارسال کلید نداشت.** `openGroup()` کلید را می‌سازد، ولی composer را **قبل** از آن زنجیره‌ی `await` رندر و فعال می‌کند، و `handleGroupMembershipChanged()` با آن مسابقه می‌دهد. پس ارسال می‌توانست قبل از وجود کلید به `encryptOutgoingGroupMessage()` برسد.

**ب) حالت بی‌صدا.** `ensureSenderKeyReady` وقتی `myMembership(groupId)` null بود `return` می‌کرد — بدون لاگ، بدون toast. epoch روی همان ردیف است، پس چیزی برای rotate نداشت، ولی فراخوان فکر می‌کرد گروه آماده است.

**ج) manifest کهنه** (بخش ۲.۱) — یعنی مرورگر کد `0a267a5` را اجرا می‌کرد، که همان دو لایه‌ی قبلی را هم داشت.

**رفع:** `buildTextBody` خودش `ensureSenderKeyReady` را صدا می‌زند؛ `ensureSenderKeyReady` در نبود عضویت، لیست اعضا را fetch می‌کند و لاگ می‌نویسد. هزینه‌ی اضافه صفر است چون `keyEnsureInflight` و Web Lock فراخوانی‌های همزمان را در یک rotation جمع می‌کنند.

**نکته:** این باگ در تست خود پروژه مستند و **دور زده** شده بود — `tests/csp-confirm-enforced-browser.test.mjs:250`:

> *"membership-event handlers race openGroup(); until then the composer reports 'No Sender Key to send with yet'"*

تست خودش `ensureSenderKeyForGroup` را دستی صدا می‌زد. چون تست با دور زدن پاس می‌شد، اصلاح نشد.

---

# ۴. کیفیت تست

## ۴.۱ X-3 تست مرده است — **باز**

`tests/groups/group-ui-security.test.mjs:232`

```
error: 'create-group control found'
```

تست در خط ۲۳۲ می‌میرد و **هرگز به assertion اصلی‌اش** (خط ۲۳۷ — که واقعاً CSP را بررسی می‌کند) نمی‌رسد. یعنی بررسی CSP گروه از قبل هیچ چیز را نمی‌سنجیده.

علت: دنبال `data-action="group-new"` می‌گردد که در هیچ فایلی در `public/` رندر نمی‌شود — فقط **handle** شده در `group.js:755`. ورودی واقعی ساخت گروه آیتم nav است (`group.js:611`).

## ۴.۲ سه تست دیگر selector کهنه دارند — **باز**

`tests/csp-xss-render.test.mjs`

| خط | خطا |
|---|---|
| :322 | `Cannot read properties of null (reading 'textContent')` |
| :353 | `Cannot read properties of null (reading 'click')` |
| :389 | `Cannot read properties of null (reading 'querySelector')` |

همه یعنی «element پیدا نشد» — قبل از رسیدن به assertion واقعی می‌میرند. همان الگوی ۴.۱.

## ۴.۳ سه تست مسیر هاردکد دارند — **باز**

```
attachment-crypto.test.mjs      10 ارجاع
auth-set-current-user.test.mjs   5 ارجاع
reactions-endpoint.test.mjs      4 ارجاع
```

همه به `/home/claude/wire` اشاره می‌کنند — مسیر سندباکس لینوکس. روی ویندوز یا هر مسیر دیگری همیشه fail می‌شوند.

## ۴.۴ چهار تست `dm-attachments` روی ویندوز fail می‌شوند — **باز**

```
failureType: 'hookFailed'
error: "EBUSY: resource busy or locked, unlink '...\\wire.db'"
```

در `after()` hook. خود assertionها **پاس می‌شوند** — فقط `fs.rmSync` نمی‌تواند فایل SQLite باز را روی ویندوز پاک کند. لینوکس اجازه می‌دهد.

## ۴.۵ E-4 flaky است — **باز**

`tests/groups/group-signing-ensure.test.mjs:185`

به `setTimeout(50ms)` برای یک درخواست عمداً معلق وابسته است. با منابع یکسان، در یک اجرا pass و در اجرای بعد fail شد.

## ۴.۶ `lockIdentity` flaky است — **باز**

بین اجراها جابه‌جا می‌شود، معمولاً با `ECONNREFUSED` روی پورت تست‌سرور.

## ۴.۷ تست‌های امنیتی Chromium اجرا نمی‌شوند — **باز**

```
# SKIP BLOCKED: no Chromium available (Cannot find module '@sparticuz/chromium')
```

تست «hostile strings در پیام unverified» که با مرورگر واقعی اجرا می‌شود، **اصلاً اجرا نشده**. skip پاس نیست.

## ۴.۸ یک تست امنیتی لازم است ولی وجود ندارد — **باز**

`config/socket.js` (بخش ۱.۳) هیچ تستی ندارد، در حالی که `authenticate.js` و `mediaAuth.js` هر دو تست دارند.

---

# ۵. کیفیت فرایند

## ۵.۱ متن پیام خطا یک قرارداد است — **آموزشی**

سه تست الگوی `/No Sender Key/` را assert می‌کنند تا ثابت کنند ارسال به‌دلیل نبود ردیف امضا رد شده. وقتی این متن را به چیزی کاربرپسندتر تغییر دادم، **همان سه تست درست شکست خوردند**.

هر پیامی که تست‌ها رویش `assert` دارند، بخشی از API است، نه تزئین.

## ۵.۲ `filter-branch` از این محیط عبور نمی‌کند — **آموزشی**

`git filter-branch --env-filter 'sh "..."'` از PowerShell → git → sh اجرا می‌شود و بی‌صدا هیچ کاری نمی‌کند (commitها byte-identical باقی می‌مانند و پیام `Ref 'refs/heads/main' is unchanged` می‌دهد).

راه‌حل: `git commit-tree` با `spawnSync` و گزینه‌ی `input`.

## ۵.۳ `execFileSync` گزینه‌ی `input` ندارد — **آموزشی**

بازسازی تاریخ، پیام هر ۵ کامیت را خالی کرد چون `execFileSync` گزینه‌ی `input` را پیاده‌سازی **نمی‌کند** — آن مخصوص `spawnSync` است.

نکته‌ی آموزنده: درخت کامیت آرگومان خط فرمان است، نه stdin. پس بررسی `tree identical: True` سبز بود در حالی که پیام‌ها از بین رفته بودند. **هر ویژگی کامیت باید جداگانه راستی‌آزمایی شود.**

---

# ۶. هنوز ساخته نشده

مواردی که در «not built yet» پلن شما بود و هنوز وضعیتشان تغییر نکرده:

- **C5** — docs، threat model، known limitations. هنوز نیامده.
- **group attachments** — عمداً غیرفعال تا بایت‌های attachment به امضای پیام متصل شوند (`signing.js:30-34` هشدار می‌دهد که امروز هر عضوی که Sender Key را دارد می‌تواند فایل جعل کند).
- **scheduled Sender Key rotation**
- **recipient-initiated KDM re-request**
- **key fingerprint / safety number** — سرور خصمانه هنوز می‌تواند کلید عمومی هویت را جایگزین کند
- **DM ratchet** — بدون forward secrecy برای DM
- **CSP enforcement** — حدود ۴۹ هندلر inline باقی مانده، `CSP_ENFORCE=false` پس CSP الان صفر محافظت می‌کند

محدودیت‌های شناخته‌شده‌ی رمزنگاری (در تست‌ها صریحاً نوشته شده):

- **C4-2:** بعد از eviction از seen-set، سرور خصمانه می‌تواند پیام ذخیره‌شده را **یک‌بار** با `sender_id` اصلی replay کند
- **C4-5:** کلاینت هیچ membership/epoch cut-off ندارد — پیامی که با کلید خودِ عضو حذف‌شده معتبر امضا شده به **خودِ او** منتسب می‌ماند. سرور دروازه‌ی عضویت است.
- متادیتا، حذف و واکنش‌ها احراز هویت نشده‌اند
- سرور کلاینت JavaScript را سرو می‌کند، پس سرور compromise‌شده می‌تواند کلاینت دستکاری‌شده بفرستد

---

# ۷. اولویت پیشنهادی

| اولویت | مورد | چرا |
|---|---|---|
| ۱ | تست `--check` برای manifest | ارزان، و جلوی تکرار ۲.۱ را می‌گیرد |
| ۲ | `.gitattributes` + renormalize | ۲.۳ می‌تواند نصب SW را روی سرور کامل بشکند |
| ۳ | ۱.۱ symlink در `downloadFile`/`previewFile` | تنها باگ امنیتی با اثر واقعی |
| ۴ | ۱.۳ `verifySessionToken` در socket | باگ امنیتی که فقط تصادفی امن است |
| ۵ | ۴.۱ / ۴.۲ تست‌های مرده | چهار تست بی‌اثر، تصویر امنیتی جعلی می‌دهند |
| ۶ | ۴.۳ مسیرهای هاردکد | تست‌ها روی هر محیط غیر از سندباکس fail می‌شوند |