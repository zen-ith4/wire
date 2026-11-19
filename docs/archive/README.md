# Wire docs: index

> **Note**: This directory (`docs/archive/`) contains documents moved from the
> top-level `docs/` during the docs reorganisation. Links inside these archived
> documents may still point to pre-reorganisation paths (e.g. `../docs/FOO.md`
> instead of `../archive/FOO.md`). There are ~200 such links; they were not
> rewritten to preserve history. When following a link that 404s, try the same
> path under `docs/archive/`.

Audited against the code on 2026-11-09; see `docs/AUDIT_REPORT.md` for exactly what was checked, changed and left open.
Rule of thumb: **if a doc and the code disagree, the code is right.**

## Start here

| doc | what it is |
|---|---|
| `REFERENCE.md` | scripts, npm commands, every environment variable, how tests are laid out and run (generated from the tree) |
| `SECURITY_CLAIMS.md` | what the encryption does and does not protect; every claim cites a file/line or a test |
| `AUDIT_REPORT.md` | the docs audit: what was verified, what was fixed, what is still open |

## Maintained, describe the current tree

| doc | what it is |
|---|---|
| `DM_V2_WIRE.md` | DM v2 operator guide: default floor, opt-in/upgrade scripts, server and client limits, tests |
| `DM_ATTACHMENTS_E2EE.md` | DM attachment encryption (STREAM container, `attachment_meta`) |
| `GROUP_E2EE_MULTIDEVICE_DESIGN.md` | group Sender Key protocol with multiple devices; section 1 is the pre-change protocol |
| `GROUP_ATTACHMENTS_E2EE.md` | group attachment crypto and receive path |
| `GROUP_ATTACHMENTS_FLAG_FLIP.md` | checklist before turning `GROUP_ATTACHMENTS_UI_ENABLED` on (it is `false`) |
| `CSP_TODO.md` | CSP status (the front-end is CSP-clean, despite the file name) and the rules for new code |
| `test-baseline.md` | measured test results (section 0a is the newest) |
| `RUN_BROWSER_TESTS_LINUX.md`, `BROWSER_TEST_ISOLATION.md`, `ci/` | how to run the browser tests on Linux and why they are isolated |
| `SLEEP_SYNC_AUDIT.md` | generated inventory of `sleep()` calls used as synchronisation in tests |

## Design records, pinned to the commits they name

Their line numbers are not maintained; their status lines were corrected where they were provably wrong.

| doc | state |
|---|---|
| `e2ee-dm-hardening.md` | design of DM v2 and peer-key trust; sections 3.5 and 8.0 are the shipped state |
| `E2EE_TRIAGE_3I.md` | risk triage after `wire-final-39` (R1-R12 with Done/open status) |
| `MEDIA_STREAMING_RFC.md` | progressive encrypted media; section 10.4 is the current state (flag OFF) |
| `PHASE3_RFC.md` | forward secrecy for DMs: **draft, no code** |
| `PORT_NOTES.md` | the v1.0.0 -> v1.3.6 port; contains a correction block for stale statements |

## Plans

| doc | state |
|---|---|
| `plans/BACKEND_IMPROVEMENT_PLAN.md` | backlog; each item now carries a verified status |

## Archive (historical, not maintained)

`archive/agent-tasks/` (STEP 1B to 3F agent prompts), `archive/WIRE_PHASE0_ITEM1_ITEM2.md`, `archive/WIRE_PHASE0_OWNER_REVIEW.md`,
`archive/PHASE_B_PLAN.md` (F12 is implemented), `archive/csp-and-dm-work-notes.md`.

## Known open problems found by the audit

- `tests/escape-attr-js-string.test.mjs` fails 3 of its tests (stale `onclick` expectation); see `test-baseline.md` 0a.
- `tests/dm-v2-vanishing-row.test.mjs` needs Chromium although its name does not say so.
- Progressive media streaming and group attachment UI are implemented but **off** (`MEDIA_STREAM_ENABLED`, `GROUP_ATTACHMENTS_UI_ENABLED`).
