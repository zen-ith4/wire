# Wire perf harness

Runs the real `public/` frontend in headless Chromium against a stub backend
(`server.cjs`) that serves static files with Express-style headers
(ETag, `Cache-Control: public, max-age=0`) and mocks the /api endpoints the four
tabs use, with configurable latency. The E2EE unlock module is stubbed in the
test browser only; nothing in `public/` is modified.

    npm i playwright && npx playwright install chromium   # once
    node measure.cjs    ../public 300 1 after   # tab switches: <dir> <ms per API request> <cpu throttle> <label>
    node functional.cjs ../public               # cache/reconcile/logout correctness (24 checks)
    node extra.cjs      ../public               # live message while away + wire_perf logger
    node sw.cjs                                 # Service Worker behaviour (20 checks; uses a temp copy of ../public)
    node launch.cjs     ../public 100           # reload with vs without the Service Worker

To compare against the original code, point `measure.cjs` at an untouched copy of `public/`.
