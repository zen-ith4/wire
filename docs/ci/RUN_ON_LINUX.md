# Running the Wire suite on Linux

Copy-paste procedures. **Every step marked `[NOT RUN HERE]` could not be executed
on the machine that produced `wire-final-25`** — there is no WSL, no Docker and no
Linux distro on it. Treat the outputs as expected, not observed.

## (a) WSL2 Ubuntu on Windows

```bash
# [NOT RUN HERE] one-time setup
wsl --install -d Ubuntu
wsl --set-default Ubuntu

# [NOT RUN HERE] node 22 (the repo pins it in .node-version)
wsl sudo apt-get update
wsl sudo apt-get install -y build-essential python3 curl
wsl curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
wsl sudo apt-get install -y nodejs

wsl mkdir -p ~/wire && cd ~/wire
```

Clone or copy the repository in, then:

```bash
cd ~/wire
npm ci                                   # [NOT RUN HERE]

# Chromium for @sparticuz/chromium / puppeteer-core.
# docs/test-baseline.md documents CHROMIUM_DIR=/tmp/browser-check.
mkdir -p /tmp/browser-check && cd /tmp/browser-check
npm init -y && npm ci @sparticuz/chromium puppeteer-core   # [NOT RUN HERE]
cd ~/wire
export CHROMIUM_DIR=/tmp/browser-check
```

The four browser files that are currently **Unverified-until-Linux**:

```bash
for f in tests/dm-v2-wire-browser.test.mjs \
         tests/dm-e2ee-default-browser.test.mjs \
         tests/peer-trust-browser.test.mjs \
         tests/mobile-groups-tab-browser.test.mjs; do
  echo "=== $f"
  node --experimental-test-module-mocks --env-file=tests/test.env \
       --test --test-timeout=60000 "$f"
done
```

The full suite:

```bash
node scripts/build-sw-manifest.mjs --check
node --experimental-test-module-mocks --env-file=tests/test.env \
     --test --test-timeout=60000 --test-concurrency=2 \
     $(find tests -name '*.test.mjs' | sort)
```

**If a file hangs** (this has happened: CPU 0, no output for 45+ min), do not
just lower concurrency and retry. Re-run that file ALONE three times and record
whether it reproduces every time / sometimes / never, and name the test it stops
at. Paste the three results in the report.

## (b) GitHub Codespaces, or the workflow in `docs/ci/linux-tests.yml`

`docs/ci/linux-tests.yml` is a GitHub Actions workflow for `ubuntu-latest`. It is
**documentation only** — it is not under `.github/` and is not activated. Copy it
to `.github/workflows/linux-tests.yml` to use it. It runs:

1. `npm ci`
2. Chrome for Testing (`npx puppeteer browsers install chrome`) and `CHROMIUM_DIR`
3. `node scripts/build-sw-manifest.mjs --check`
4. the full suite with `--test-timeout=60000 --test-concurrency=2`

In Codespaces the same steps apply; the codespace already has Chrome, so skip
step 2 and set `CHROMIUM_DIR` to wherever `@sparticuz/chromium` is installed.

**Untestable from here:** the workflow itself has never executed (no runner), and
no step that touches a real Chromium has ever run on Linux from this tree.

## What is browser-only and still needs this

- UI rendering of DM v2 threads end to end (now covered on Windows by
  `tests/dm-v2-wire-browser.test.mjs`, but not on a real Linux Chromium).
- Held messages under a key-change alarm, the key-trust banner, the
  "conversation was downgraded" toast, and conversation-list / reply previews.
- `tests/groups/group-e2e-browser.test.mjs` and
  `tests/acceptance-xss-sweep-browser.test.mjs`.