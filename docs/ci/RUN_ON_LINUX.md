# Running the Wire suite on Linux

Copy-paste procedures. Steps still marked `[NOT RUN HERE]` could not be executed
on the machine that produced `wire-final-26` — there is no WSL, no Docker and no
Linux distro on it. Treat those outputs as expected, not observed.

**Everything else in this file has Linux evidence.** The reviewer ran the
unmodified `wire-final-25` zip on Linux (node v22.22.2, `npm ci`, Chromium via
`@sparticuz/chromium`, `CHROMIUM_DIR=/tmp/browser-check`); the numbers are in
section 0 of `docs/DM_V2_WIRE.md`. Those are the reviewer's results, recorded
here — not claims made by this tree.

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
npm ci                                   # observed on Linux by the reviewer, see DM_V2_WIRE.md section 0

# Chromium for @sparticuz/chromium / puppeteer-core.
# docs/test-baseline.md documents CHROMIUM_DIR=/tmp/browser-check.
#
# NOTE: `npm install`, NOT `npm ci`. The command shipped here in wire-final-25 read
# `npm ci @sparticuz/chromium puppeteer-core`, which is wrong: `npm ci` takes no
# package names, so it fails. Fixed in wire-final-26.
mkdir -p /tmp/browser-check && cd /tmp/browser-check
npm init -y && npm install @sparticuz/chromium puppeteer-core   # observed on Linux by the reviewer
cd ~/wire
export CHROMIUM_DIR=/tmp/browser-check
```

The browser files, and what the reviewer observed on Linux with the unmodified
wire-final-25 zip (node v22.22.2): **all pass, 0 fail, 0 cancelled.**

- `dm-v2-wire-browser`, `dm-e2ee-default-browser`, `peer-trust-browser` (3),
  `mobile-groups-tab-browser` (4), `identity-key-history-browser`,
  `csp-confirm-enforced-browser`, `dm-csp-handlers-enforced-browser`,
  `credentials/f12-browser-login` (6), `groups/group-e2e-browser`,
  `group-confirm-in-dialog-browser`, `group-csp-browser`,
  `group-dialog-create-settled-browser`, `group-hostile-browser`,
  `acceptance-xss-sweep-browser` (8, 1 skip), `acceptance-no-plaintext` (8).

So the earlier "Windows-only renderer freeze" labels were **environmental** for
group-e2e, peer-trust, mobile-groups-tab and xss-sweep. For `dm-v2-wire-browser`
the cause was the two v2 bugs fixed in 1E, not the environment.

Reproduce:

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

**Untestable from here:** the workflow itself has never executed on a GitHub
runner — it is still documentation, not a live workflow. The reviewer's run was
**not** this workflow; it was the same commands by hand.

## What is browser-only and no longer needs this

Everything below was Unverified-until-Linux until the reviewer ran the unmodified
wire-final-25 zip. It now has Linux evidence (section 0 of `docs/DM_V2_WIRE.md`):

- DM v2 threads end to end (`dm-v2-wire-browser`).
- Held messages under a key-change alarm, the key-trust banner
  (`peer-trust-browser`).
- Conversation-list and reply previews, the mobile groups tab
  (`mobile-groups-tab-browser`).
- `tests/groups/group-e2e-browser.test.mjs` and
  `tests/acceptance-xss-sweep-browser.test.mjs`.

The downgrade toast ("This conversation was downgraded to legacy encryption") is
the one item here the reviewer did **not** name; see `tests/dm-v2-wire-browser-paths.test.mjs`
(g) for the test that covers it.