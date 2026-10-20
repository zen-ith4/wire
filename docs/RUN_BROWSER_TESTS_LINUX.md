# Running the browser tests on Linux (the owner's recipe)

**Status: UNVERIFIED.** This recipe and `scripts/run-browser-tests-linux.sh`
were written on Windows by an agent that could not run Linux. Nothing here
has been executed on a Linux machine yet. Treat the first run as a debugging
session: the commands are exact, but the *outcome* is not proven.

The project normally runs its browser tests with `@sparticuz/chromium`, a
**Linux** binary. On Windows it cannot run at all (the binary is an ELF), so
the browser results in the reports so far are "system Chrome on Windows" (and
since STEP 3D item 4 that fallback is opt-in:
`WIRE_TEST_ALLOW_SYSTEM_BROWSER=1`). The **Linux run is the last open item**
of `docs/GROUP_ATTACHMENTS_FLAG_FLIP.md`.

---

## What the tests need

| What | Why | Where |
|---|---|---|
| Node 22 | the runner and the test files | `.node-version` (22.23.2) |
| the tree's own dependencies | the server and the test helpers | `npm ci` |
| `puppeteer-core` + `@sparticuz/chromium` | the browser | **not** project dependencies: the harness resolves them from `CHROMIUM_DIR` (default `/tmp/browser-check`) - `tests/_acceptance-harness.mjs:324` |
| a few shared libraries | the Chromium binary | see the Docker route below |

The versions that are known to work together with this tree:
`puppeteer-core@25.14.0` and `@sparticuz/chromium@153.0.0` (the pair that is
installed in the owner's `browser-check` directory).

---

## Route 1 - WSL2 (Ubuntu)

```sh
# 1. WSL2 + Ubuntu
wsl --install -d Ubuntu          # in PowerShell (admin); reboot if asked

# 2. inside WSL: Node 22 (the version the tree expects)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. the tree must live on the LINUX filesystem, not on /mnt/c
#    (a /mnt/c tree is slow and the file modes are wrong)
mkdir -p ~/wire
cp -a /mnt/c/Users/<you>/path/to/the/tree/. ~/wire/tree
cd ~/wire/tree

# 4. the app's dependencies
npm ci

# 5. the browser packages, where the harness looks for them
mkdir -p /tmp/browser-check && cd /tmp/browser-check
npm init -y
npm install --no-audit --no-fund puppeteer-core@25.14.0 @sparticuz/chromium@153.0.0
cd ~/wire/tree

# 6. run the group attachment browser tests
export CHROMIUM_DIR=/tmp/browser-check
node --experimental-test-module-mocks --env-file=tests/test.env \
  --test --test-timeout=900000 tests/groups/group-attachment-browser.test.mjs
```

The first TAP lines must name the project's own browser:

```
# # browser: chromium (@sparticuz/chromium) HeadlessChrome/153.0.0.0
ok 1 - 1 honest send and receive: an image renders inline, a PDF is a download
...
# tests 10
# pass 10
# fail 0
```

If the line says `system browser ...`, the **fallback** was used - that
happens only when `WIRE_TEST_ALLOW_SYSTEM_BROWSER=1` is set, so unset it
(`unset WIRE_TEST_ALLOW_SYSTEM_BROWSER`) and check that
`CHROMIUM_DIR` really points at the directory with the two packages.

---

## Route 2 - Docker (one command)

```sh
# from the tree root
scripts/run-browser-tests-linux.sh
```

That script runs, in one `docker run`:

1. the official `node:22-bookworm` image;
2. the shared libraries the Chromium binary needs on a Debian slim image
   (`libnss3`, `libatk1.0-0`, `libatk-bridge2.0-0`, `libcups2`, `libdrm2`,
   `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`,
   `libxrandr2`, `libgbm1`, `libpango-1.0-0`, `libcairo2`, `libasound2`,
   `libatspi2.0-0`, `fonts-liberation`, `ca-certificates`) - note that
   `@sparticuz/chromium` ships the AL2023 libraries itself
   (`bin/al2023.tar.br`, extracted into `/tmp/al2023`), so only the base
   image's libraries are missing;
3. a **read-only** bind mount of the tree, copied to a writable place
   (`cp -a /src /work/tree`) so that `npm ci` cannot touch the Windows tree;
4. `npm ci` and the browser packages in `CHROMIUM_DIR`;
5. the browser test file, with `WIRE_TEST_ALLOW_SYSTEM_BROWSER` unset.

The script exits non-zero when the tests fail.

The one-liner it wraps (if you want to run it by hand):

```sh
docker run --rm -v "$PWD:/src:ro" -v wire-browser-tests:/work node:22-bookworm bash -euxo pipefail -c '
  apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2 libatspi2.0-0 fonts-liberation
  rm -rf /work/tree && cp -a /src /work/tree && cd /work/tree && npm ci
  mkdir -p /opt/browser-check && cd /opt/browser-check && npm init -y >/dev/null \
    && npm install --no-audit --no-fund puppeteer-core@25.14.0 @sparticuz/chromium@153.0.0
  cd /work/tree && CHROMIUM_DIR=/opt/browser-check \
    node --experimental-test-module-mocks --env-file=tests/test.env \
      --test --test-timeout=900000 tests/groups/group-attachment-browser.test.mjs'
```

---

## What to do with the result

- **Green, and the TAP line says `chromium (@sparticuz/chromium)`**: tick the
  first box of `docs/GROUP_ATTACHMENTS_FLAG_FLIP.md` (section 2.1) and say
  in the report that the browser results are "the project's Chromium on
  Linux", not "system Chrome on Windows".
- **Red**: the failure output is the input for the next step. Do not flip the
  flag on a red run.
- **The TAP line says `system browser`**: the fallback ran - the Linux
  Chromium was not found. Check `CHROMIUM_DIR` and that
  `npm install` put the two packages there.

## What the project already assumes

- `docs/BROWSER_TEST_ISOLATION.md`: the browser tests need **one browser
  process per account** (single-process Chromium cannot do
  `createBrowserContext()`), which is what `newUserPage()` does. That
  document's numbers come from Windows + local Chrome, not from
  `@sparticuz/chromium` on Linux - so the Linux numbers are still unknown.
- The harness runs `@sparticuz/chromium` with its own arguments
  (`--single-process --no-zygote ...`); on Linux that is the intended
  configuration, and the isolation document is the reason the per-account
  process exists.
