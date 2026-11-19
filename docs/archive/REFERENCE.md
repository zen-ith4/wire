# Wire: reference (scripts, environment, tests)

Generated on 2026-11-09 from the checkout (package.json files, `scripts/`, `process.env.*` reads, `tests/`). Nothing here is
copied from older docs. When it disagrees with the code, the code is right: regenerate it.

Node version pinned in `.node-version`: **22.23.2**.

## npm scripts (root `package.json`)

| command | runs |
|---|---|
| `npm start` | `node server.js` |
| `npm test` | `node scripts/run-tests.mjs` |
| `npm run test:groups` | `node scripts/run-tests.mjs tests/groups` |
| `npm run test:crypto` | `node scripts/run-tests.mjs tests/crypto` |
| `npm run test:excluded` | `node scripts/run-tests.mjs --excluded` |
| `npm run admin` | `node scripts/admin-cli.mjs` |
| `npm run dev` | `nodemon server.js` |
| `npm run dev:watch` | `nodemon` |

## npm scripts (`electron-client/package.json`)

| script | runs |
|---|---|
| `start` | `electron .` |
| `dist` | `electron-builder --win nsis --linux AppImage deb` |
| `dist:win` | `electron-builder --win nsis` |
| `dist:linux` | `electron-builder --linux AppImage deb` |
| `dist:dir` | `electron-builder --dir` |

## `scripts/`

Descriptions are the first comment lines of each file.

| file | what it says it does |
|---|---|
| `scripts/admin-cli.mjs` | Server-side admin commands (recovery and setup). Run on the server shell, with the same .env and DB as the app: |
| `scripts/audit-usernames.mjs` | Read-only: lists stored usernames that break the rules for NEW accounts and names that collide case-insensitively. Changes nothing (the database is opened read-only). |
| `scripts/build-sw-manifest.mjs` | Generates public/sw-manifest.js: the list of application-shell files (with SHA-256 content hashes) that public/sw.js precaches, plus a version derived |
| `scripts/build-sw-media-bundle.mjs` | Generates public/sw-media-bundle.js: the Service Worker's media bundle. node scripts/build-sw-media-bundle.mjs              write public/sw-media-bundle.js |
| `scripts/dm-e2ee-optin.mjs` | scripts/dm-e2ee-optin.mjs Opt accounts in to DM envelope v2 by raising users.dm_e2ee_min_version from 1 |
| `scripts/dm-e2ee-upgrade-existing.mjs` | scripts/dm-e2ee-upgrade-existing.mjs Raise every account still at dm_e2ee_min_version = 1 to 2. Admin-only: needs |
| `scripts/experiments/` | 1 experiment files (not part of the app or the test run) |
| `scripts/run-browser-tests-linux.sh` | STEP 3E item 4: run the group attachment browser tests on LINUX with the project's own Chromium (@sparticuz/chromium). |
| `scripts/run-tests.mjs` | Test runner for `npm test`. Runs every tests/**/*.test.mjs except the ones listed in |

## Environment variables the server and scripts read

First place each one is read (outside `tests/`, `electron-client/`, vendored code). The last column says whether `.env.example` mentions it (commented lines count).
Defaults live next to the read, mostly in `config/constants.js`; they are deliberately not repeated here.

| variable | first read at | in `.env.example` |
|---|---|---|
| `NODE_ENV` | `config/constants.js:4` | yes |
| `DM_E2EE_DEFAULT_MIN_VERSION` | `config/constants.js:9` | yes |
| `JWT_SECRET` | `config/constants.js:54` | yes |
| `EMAIL_VERIFICATION_SECRET` | `config/constants.js:82` | yes |
| `PORT` | `config/constants.js:106` | yes |
| `HOST` | `config/constants.js:107` | yes |
| `DB_PATH` | `config/constants.js:115` | yes |
| `ALLOWED_SUBNET` | `config/constants.js:123` | yes |
| `WG_INTERFACE` | `config/constants.js:134` | yes |
| `PUBLIC_BASE_URL` | `config/constants.js:153` | yes |
| `UPLOAD_MAX_MB` | `config/constants.js:161` | yes |
| `CHAT_UPLOAD_MAX_MB` | `config/constants.js:162` | yes |
| `DM_UPLOAD_MAX_MB` | `config/constants.js:163` | yes |
| `AVATAR_MAX_MB` | `config/constants.js:164` | yes |
| `BANNER_MAX_MB` | `config/constants.js:165` | yes |
| `USER_DATA_ROOT` | `config/constants.js:172` | yes |
| `ALLOWED_FOLDER_ROOTS` | `config/constants.js:178` | yes |
| `CHAT_UPLOAD_DIR` | `config/constants.js:189` | yes |
| `DM_UPLOAD_DIR` | `config/constants.js:193` | yes |
| `AVATAR_DIR` | `config/constants.js:197` | yes |
| `BANNER_DIR` | `config/constants.js:201` | yes |
| `GROUPS_ENABLED` | `config/constants.js:211` | yes |
| `GROUP_UPLOAD_MAX_MB` | `config/constants.js:213` | yes |
| `GROUP_UPLOAD_DIR` | `config/constants.js:216` | yes |
| `DEFAULT_ADMIN_USER` | `config/constants.js:223` | yes |
| `DEFAULT_ADMIN_PASS` | `config/constants.js:224` | yes |
| `APK_PATH` | `config/constants.js:251` | yes |
| `APK_VERSION_NAME` | `config/constants.js:254` | yes |
| `APK_VERSION_CODE` | `config/constants.js:256` | yes |
| `APK_PACKAGE_ID` | `config/constants.js:264` | yes |
| `SETUP_COMPLETED` | `config/constants.js:282` | yes |
| `CLIENT_URL` | `config/socket.js:20` | yes |
| `DM_E2EE_TEXT_ENFORCED` | `controllers/dm.controller.js:81` | yes |
| `DM_E2EE_ATTACHMENTS_ENFORCED` | `controllers/dm.controller.js:206` | yes |
| `BCRYPT_ROUNDS` | `database/seed.js:59` | yes |
| `CSP_ENFORCE` | `middleware/csp.js:34` | yes |
| `LOADTEST_DISABLE_RATE_LIMITS` | `middleware/rateLimiter.js:312` | **no** |
| `IDENTITY_ROTATE_MAX_PER_HOUR` | `middleware/rateLimiter.js:631` | yes |
| `IDENTITY_HISTORY_MAX_PER_HOUR` | `middleware/rateLimiter.js:647` | yes |
| `EMAIL_ENABLED` | `services/email.service.js:4` | yes |
| `SMTP_PORT` | `services/email.service.js:9` | yes |
| `SMTP_HOST` | `services/email.service.js:12` | yes |
| `SMTP_USER` | `services/email.service.js:16` | yes |
| `SMTP_PASSWORD` | `services/email.service.js:17` | yes |
| `SMTP_FROM` | `services/email.service.js:30` | yes |
| `EMAIL_2FA_SECRET` | `services/email2fa.service.js:27` | yes |
| `GROUP_DEVICE_CAP` | `services/groupKdm.service.js:125` | yes |
| `GROUP_DEVICE_NEW_PER_HOUR` | `services/groupKdm.service.js:126` | yes |
| `GROUP_DEVICE_GRACE` | `services/groupKdm.service.js:131` | yes |
| `GROUP_DEVICE_TTL_DAYS` | `services/groupKdm.service.js:132` | yes |
| `GOOGLE_APPLICATION_CREDENTIALS` | `services/push.service.js:44` | yes |
| `PUBLIC_HOST` | `utils/setupWizard.js:111` | **no** |
| `HTTPS_MODE` | `utils/setupWizard.js:113` | **no** |
| `DOMAIN` | `utils/setupWizard.js:114` | **no** |
| `TLS_CERT_FINGERPRINT` | `utils/setupWizard.js:115` | **no** |

## Tests

- `159` test files; layout:

| directory | test files | of them with "browser" in the name |
|---|---|---|
| `tests/` | 66 | 14 |
| `tests/groups/` | 54 | 7 |
| `tests/crypto/` | 11 | 1 |
| `tests/credentials/` | 13 | 1 |
| `tests/media/` | 5 | 1 |
| `tests/dm-attachments/` | 9 | 0 |
| `tests/admin/` | 1 | 0 |

- Run everything the project considers applicable: `npm test` (`scripts/run-tests.mjs`). Groups only: `npm run test:groups`. Files that exercise behaviour this tree lacks are listed in `tests/EXCLUDED_NOT_APPLICABLE.json` (currently 0 entries) and run with `npm run test:excluded`.
- `tests/test.env` is loaded with `--env-file`; it sets `CSP_ENFORCE=true` for the run.
- Browser tests need Chromium that is **not** a project dependency: they look in `CHROMIUM_DIR` (default `/tmp/browser-check`) for `puppeteer-core` and `@sparticuz/chromium`. Recipes: `docs/RUN_BROWSER_TESTS_LINUX.md`, `docs/ci/RUN_ON_LINUX.md`. Without them those files fail with `no Chromium`.
- One non-"browser"-named file also needs Chromium: `tests/dm-v2-vanishing-row.test.mjs`.
- Test-only environment variables seen in `tests/`: `ATTR_DUMP`, `C4B_ORDER`, `C5_PUBLIC_DIR`, `CHROME_PATH`, `CHROMIUM_DIR`, `DM_ATTACH_E2EE`, `DM_E2EE_ATTACHMENTS_ENFORCED`, `DM_E2EE_DEFAULT_MIN_VERSION`, `DM_UPLOAD_DIR`, `DM_UPLOAD_MAX_MB`, `FIXTURE_BUILT_FROM`, `WIRE_TEST_ALLOW_SYSTEM_BROWSER`, `WIRE_TEST_DEBUG_FETCH`.
- Latest measured results: `docs/test-baseline.md` (sections 0 and 0a).
