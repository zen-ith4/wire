// tests/_port.mjs
//
// One place that knows which TCP ports Node's fetch (undici) refuses to
// connect to, whatever is listening on them.
//
// WHY THIS EXISTS
// A test server that lands on one of those ports starts fine, prints
// "started successfully", and then every fetch() the test makes throws
// `TypeError: fetch failed` with cause `bad port`. The suite then reports
// "server did not start" for a server that did start, which is both wrong and
// maddening to chase.
//
// WHERE THE LIST COMES FROM
// Verbatim from undici's own source, not from memory:
//
//   node_modules/undici/lib/web/fetch/constants.js
//   line 14:  const badPorts = /** @type {const} */ ([
//   lines 15-20: the entries
//   line 21:  ])
//
// undici 8.10.2 is installed as a dependency in this repo. Node bundles its own
// copy for the global `fetch`, and that copy is what the tests actually run
// against, so tests/port-hygiene.test.mjs does not take undici's word for it:
// it binds a real server on every entry that an unprivileged process may bind
// and asserts fetch() really refuses, and it compares this file against the
// installed undici's source so the two cannot drift apart silently.
//
// Entries below 1024 are listed for fidelity with undici. They cannot be
// proved behaviourally here - an unprivileged process cannot bind a privileged
// port - so the behavioural test only covers 1024 and above, and says so.
//
// A NOTE ON THE OTHER `listen(0)` CALL SITES
// The helpers that use listenEphemeral() do so deliberately, but they were never
// in danger: `listen(0)` asks the OS for a port from the ephemeral range
// (32768-60999 on Linux, 49152-65535 on Windows), and undici's highest blocked
// port is 10080. The two cannot overlap on either platform. The check is kept
// anyway so the invariant is explicit instead of resting on an assumption about
// sysctl defaults, and so a future sysctl change fails loudly rather than
// flaking.

export const FETCH_BLOCKED_PORTS = new Set([
  // undici 8.10.2, lib/web/fetch/constants.js:14-21
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79,
  87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137,
  139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723,
  2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** Ports this process is actually able to bind, i.e. the provable subset. */
export const BINDABLE_BLOCKED_PORTS = [...FETCH_BLOCKED_PORTS].filter((p) => p >= 1024);

export function isFetchBlockedPort(port) {
  return FETCH_BLOCKED_PORTS.has(Number(port));
}

/**
 * Bind, but never settle on a port fetch() would refuse.
 *
 * `tryListen` must bind something and resolve with the port it got; if that
 * port is blocked it is expected to release it again before the next call.
 * Passing a listener factory (rather than a server) keeps this testable: the
 * unit test feeds it a scripted sequence of ports and asserts the blocked ones
 * are skipped, which is exactly the behaviour that is easy to delete by
 * accident.
 *
 * @param {(attempt: number) => Promise<number>} tryListen
 * @param {{attempts?: number}} [opts]
 * @returns {Promise<number>} a port that is free AND fetchable
 */
export async function listenAvoidingBlockedPorts(tryListen, { attempts = 20 } = {}) {
  const skipped = [];

  for (let attempt = 0; attempt < attempts; attempt++) {
    const port = await tryListen(attempt);

    if (!isFetchBlockedPort(port)) return port;

    skipped.push(port);
  }

  throw new Error(
    `no fetchable port after ${attempts} attempts; refused: ${skipped.join(', ')}`
  );
}

/** net.Server convenience wrapper: bind an ephemeral port, retrying if blocked. */
export function listenEphemeral(server, { host = '127.0.0.1', ...opts } = {}) {
  return listenAvoidingBlockedPorts(
    () =>
      new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      }),
    opts
  );
}