// tests/port-hygiene.test.mjs
//
// The harness used to pick ports without consulting undici's refused list, so a
// server could bind 5060 or 5061, print "started successfully", and then every
// fetch() the test made threw `bad port`. These tests pin down both halves:
//
//   1. the list in tests/_port.mjs is REAL - each entry is proved by binding a
//      server on it and watching fetch() refuse;
//   2. the retry actually skips a refused port, proved with a scripted
//      sequence so it does not depend on the OS ever handing one out.
//
// Delete the isFetchBlockedPort() check in listenAvoidingBlockedPorts() and the
// second test goes red.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';

import {
  FETCH_BLOCKED_PORTS,
  BINDABLE_BLOCKED_PORTS,
  isFetchBlockedPort,
  listenAvoidingBlockedPorts,
  listenEphemeral,
} from './_port.mjs';

// Only these can be bound by an unprivileged process, so only these can be
// proved by behaviour. The rest are listed for fidelity with undici and are
// covered by the source-comparison test instead.
const BINDABLE = BINDABLE_BLOCKED_PORTS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Why a listed port could not be proved by behaviour, or null if it could.
 *
 * EACCES is the same class of fact as EADDRINUSE: the OS will not let this
 * process bind the port, so there is nothing to observe. Port 6697 sits in a
 * Windows reserved range (Hyper-V / WSL claim blocks of ports) and failed here
 * with `listen EACCES: permission denied 127.0.0.1:6697`, which turned a blocked-
 * list check into an unrelated failure.
 *
 * Returned rather than thrown so the caller can PRINT why a port was skipped -
 * a silent skip is how a genuinely unreachable check hides.
 *
 * Any other error is a real failure and is thrown.
 */
async function unbindableReason(port, host = '127.0.0.1') {
  const srv = net.createServer((s) => s.end());
  try {
    await bindWithRetry(srv, port, host);
    return null;
  } catch (e) {
    if (e?.code === 'EACCES') {
      return `EACCES: the OS refuses to bind 127.0.0.1:${port} (reserved port range?) - ` +
        `cannot be proved by behaviour here`;
    }
    throw e;
  } finally {
    await new Promise((r) => srv.close(r)).catch(() => {});
  }
}

// Binding and immediately releasing these ports in a tight loop can hand back
// EADDRINUSE while the previous socket is still winding down (notably on
// Windows). That is a fact about the machine, not about the blocked list, so
// retry rather than let a busy port masquerade as a real failure.
async function bindWithRetry(srv, port, host = '127.0.0.1', tries = 12) {
  for (let i = 0; i < tries; i++) {
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, host, () => {
          srv.removeListener('error', reject);
          resolve();
        });
      });
      return;
    } catch (e) {
      if (e?.code !== 'EADDRINUSE' || i === tries - 1) throw e;
      await sleep(120);
    }
  }
}

async function fetchAgainst(port) {
  const srv = net.createServer((s) => s.end());
  await bindWithRetry(srv, port);
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1500);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal });
      return `ALLOWED(${res.status})`;
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return `BLOCKED(${e?.cause?.code || e?.name || e?.message})`;
  } finally {
    await new Promise((r) => srv.close(r));
  }
}

test('our list is undici\'s list, copied from its source verbatim', async () => {
  const path = await import('node:path');
  const fs = await import('node:fs');
  const file = path.join(process.cwd(), 'node_modules', 'undici', 'lib', 'web', 'fetch', 'constants.js');

  // undici is a real dependency of this repo. If the file is missing, that is a
  // BROKEN TREE, not a reason to pass: this test exists to prove the copy in
  // tests/_port.mjs cannot drift from its source, and a missing source proves
  // nothing at all. It used to `return` here, which silently turned "undici
  // vanished" into a green run.
  const src = fs.readFileSync(file, 'utf8');

  const at = src.indexOf('const badPorts');
  assert.ok(at !== -1, `no badPorts constant in ${file}`);

  // Take ONLY the bracketed literal, so numbers from later constants in the
  // same file cannot leak into the comparison.
  const open = src.indexOf('[', at);
  const close = src.indexOf(']', open);
  const entries = [...src.slice(open, close).matchAll(/'(\d+)'/g)].map((m) => Number(m[1]));

  assert.ok(entries.length > 50, `parsed a suspiciously short list: ${entries.length}`);

  const ours = [...FETCH_BLOCKED_PORTS].sort((a, b) => a - b);
  assert.deepEqual(
    ours,
    [...new Set(entries)].sort((a, b) => a - b),
    'tests/_port.mjs must equal undici\'s badPorts exactly - no additions, no omissions'
  );
});

// --------------------------------------------------------------------------
// pickFreePort() itself
//
// The mutation this must catch: deleting `if (BLOCKED_PORTS.has(candidate))
// continue;` from pickFreePort(). Driven with an INJECTED random source that
// walks the whole 4600..5499 window deterministically, because with a real
// random source only 2 of 900 candidates are blocked - a deleted check would
// pass about 99.8% of the time and this test would be theatre.
// --------------------------------------------------------------------------

test('pickFreePort() skips the refused ports in its own window, deterministically', async () => {
  const { pickFreePort } = await import('./_acceptance-harness.mjs');

  // 4600 + floor(random()*900) => 4600..5499. Hand it each candidate in turn.
  const seen = [];
  let cursor = 0;
  const walker = () => {
    const value = (cursor % 900) / 900;
    cursor++;
    return value;
  };

  for (let i = 0; i < 900; i++) {
    const port = await pickFreePort({ random: walker });
    seen.push(port);
    assert.ok(!isFetchBlockedPort(port),
      `pickFreePort() returned the fetch-blocked port ${port}`);
  }

  // The walk must have stepped over 5060 and 5061 rather than landing on them:
  // at cursor 460 the candidate is 5060 and at 461 it is 5061.
  assert.ok(seen.length >= 900, `expected 900 picks, got ${seen.length}`);
  assert.ok(!seen.includes(5060), '5060 must never be handed out');
  assert.ok(!seen.includes(5061), '5061 must never be handed out');
});

test('pickFreePort() still refuses a port the OS will not bind', async () => {
  const { pickFreePort } = await import('./_acceptance-harness.mjs');

  // Hold a port INSIDE pickFreePort()'s window (listen(0) would give an
  // ephemeral port in the 32768+ range and this would not test anything), then
  // force every candidate onto it with a constant random source. The blocked
  // check passes it, because it is not a blocked port - so what has to reject it
  // is the bindability probe, the second half of the same function.
  let held = null;
  let heldPort = 0;

  for (let candidate = 4600; candidate <= 5499 && heldPort === 0; candidate++) {
    if (isFetchBlockedPort(candidate)) continue;
    const s = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        s.once('error', reject);
        s.listen(candidate, '127.0.0.1', resolve);
      });
      held = s;
      heldPort = candidate;
    } catch {
      /* busy, try the next one */
    }
  }

  assert.ok(held, 'could not hold any port in pickFreePort()\'s window on this machine');

  try {
    // Ask for the held port three times, then walk onward. Returning it
    // FOREVER would be a different test: pickFreePort() would exhaust its 60
    // attempts and throw, which is correct but proves only the retry limit.
    let calls = 0;
    const heldAttempts = 3;
    const source = () => {
        const offset = calls < heldAttempts ? 0 : calls - heldAttempts + 1;
        calls++;
        return (heldPort - 4600 + offset) / 900;
    };

    const port = await pickFreePort({ random: source });

    assert.ok(calls > heldAttempts,
      `pickFreePort() must have retried past the held port; it stopped after ${calls} call(s)`);
    assert.notEqual(port, heldPort,
      'pickFreePort() handed out a port it had just proved it could not bind');
    assert.ok(port >= 4600 && port <= 5499, `and it should stay in its window, got ${port}`);
  } finally {
    await new Promise((r) => held.close(r));
  }
});

// --------------------------------------------------------------------------
// Node's BUNDLED undici, not the on-disk copy
//
// The source comparison proves tests/_port.mjs matches the undici *package*
// on disk. This proves the list also matches what the global `fetch` in THIS
// Node process actually refuses - because that, not the package, is what a test
// hits. "fetch failed" alone is not enough: a TCP refusal throws the same
// TypeError. The discriminator is undici's own cause, message 'bad port'.
// --------------------------------------------------------------------------

test('every bindable entry is refused by THIS Node\'s bundled undici, with a bad-port cause', async () => {
  assert.ok(BINDABLE.length >= 10, `expected a non-trivial list, got ${BINDABLE.length}`);

  const wrongCause = [];
  const reached = [];
  const skipped = [];

  for (const port of BINDABLE) {
    // A port the OS will not let us bind cannot be proved either way. Skipped
    // WITH A PRINTED REASON rather than silently; any other bind error still
    // fails the test.
    const reason = await unbindableReason(port);
    if (reason) {
      skipped.push(`${port}: ${reason}`);
      continue;
    }

    const srv = net.createServer((c) => c.end());
    let listening = false;
    try {
      await new Promise((resolve, reject) => {
        srv.once('error', reject);
        srv.listen(port, '127.0.0.1', () => { listening = true; resolve(); });
      });
    } catch (e) {
      // EADDRINUSE only: a port held by another process this instant. EACCES is
      // handled above; anything else is a real failure and is not swallowed.
      if (e?.code !== 'EADDRINUSE') throw e;
      skipped.push(`${port}: EADDRINUSE (held by another process at this instant)`);
      continue;
    }

    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
      reached.push(port);
    } catch (e) {
      const cause = String(e?.cause?.message || '');
      const code = String(e?.cause?.code || '');
      // undici's refusal: message 'bad port', no code.
      // A TCP refusal would be code ECONNREFUSED and message 'connect ECONNREFUSED ...'.
      if (cause !== 'bad port' || code !== '') {
        wrongCause.push(`${port}: cause=${JSON.stringify(cause)} code=${JSON.stringify(code)}`);
      }
    } finally {
      if (listening) await new Promise((r) => srv.close(r));
    }
  }

  if (skipped.length) {
    console.log(`    [port-hygiene] skipped ${skipped.length} unbindable port(s):`);
    for (const line of skipped) console.log(`      ${line}`);
  }

  assert.ok(BINDABLE.length - skipped.length >= 10,
    `only ${BINDABLE.length - skipped.length} of ${BINDABLE.length} ports were actually proved`);
  assert.deepEqual(reached, [],
    `listed as fetch-blocked, but fetch() actually connected: ${reached.join(', ')}`);
  assert.deepEqual(wrongCause, [],
    `these failed for a reason other than undici's bad-port refusal: ${wrongCause.join(', ')}`);
});

test('the acceptance harness uses the shared list, not a copy of its own', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const file = path.join(process.cwd(), 'tests', '_acceptance-harness.mjs');
  const src = fs.readFileSync(file, 'utf8');

  assert.match(
    src,
    /import \{ FETCH_BLOCKED_PORTS \} from '\.\/_port\.mjs';/,
    'the harness imports the shared list'
  );
  assert.match(
    src,
    /const BLOCKED_PORTS = FETCH_BLOCKED_PORTS;/,
    'and its own constant is that set, not a second hand-maintained list'
  );
  assert.ok(
    !/new Set\(\[\s*\d/.test(src),
    'the harness must not define its own numeric blocked-port list'
  );
});

test('every bindable entry in FETCH_BLOCKED_PORTS is genuinely refused by fetch()', async () => {
  assert.ok(BINDABLE.length >= 10, `expected a non-trivial list, got ${BINDABLE.length}`);

  const notBlocked = [];
  const skipped = [];

  for (const port of BINDABLE) {
    // A port the OS will not let us bind cannot be proved either way. It is
    // skipped WITH A PRINTED REASON - never silently, because a silent skip is
    // how a check quietly stops checking anything.
    const reason = await unbindableReason(port);
    if (reason) {
      skipped.push(`${port}: ${reason}`);
      continue;
    }

    const verdict = await fetchAgainst(port);
    if (!verdict.startsWith('BLOCKED')) notBlocked.push(`${port}->${verdict}`);
  }

  // Printed on success too, so a run that skipped a port says so instead of
  // looking like it covered everything.
  if (skipped.length) {
    console.log(`    [port-hygiene] skipped ${skipped.length} unbindable port(s):`);
    for (const line of skipped) console.log(`      ${line}`);
  }

  // Skipping must not become a way out: if nothing was actually proved, say so.
  const proved = BINDABLE.length - skipped.length;
  assert.ok(proved >= 10, `only ${proved} of ${BINDABLE.length} ports were actually proved`);

  assert.deepEqual(
    notBlocked,
    [],
    `these are listed as fetch-blocked but fetch() reached them: ${notBlocked.join(', ')}`
  );
});

test('the ports pickFreePort() actually picks from are refused by fetch()', async () => {
  // pickFreePort() draws 4600 + random(900), i.e. 4600..5499. Whatever the OS
  // hands out inside that window must not be a refused port.
  const inWindow = [...FETCH_BLOCKED_PORTS].filter((p) => p >= 4600 && p <= 5499);
  assert.deepEqual(inWindow, [5060, 5061], 'the window contains exactly these two');

  for (const port of inWindow) {
    assert.ok(isFetchBlockedPort(port), `${port} is recognised as blocked`);
    assert.match(await fetchAgainst(port), /^BLOCKED\(/, `${port} really is refused`);
  }
});

test('listenAvoidingBlockedPorts skips a refused port and returns the next one', async () => {
  const tried = [];
  // 5060, 5061 and 6000 are all on the refused list; 5321 is not.
  const scripted = [5060, 5061, 6000, 5321];

  // The helper hands tryListen the attempt number; use it, and record it.
  const chosen = await listenAvoidingBlockedPorts(async (attempt) => {
    tried.push(attempt);
    return scripted[attempt];
  });

  assert.deepEqual(tried, [0, 1, 2, 3], 'it tried 5060, 5061 and 6000 before 5321');
  assert.equal(chosen, 5321, 'and returned the first port that is not refused');
});

test('listenAvoidingBlockedPorts returns immediately when the first port is fine', async () => {
  let calls = 0;
  const chosen = await listenAvoidingBlockedPorts(async () => {
    calls++;
    return 4711;
  });
  assert.equal(chosen, 4711);
  assert.equal(calls, 1, 'no second bind was needed');
});

test('listenAvoidingBlockedPorts fails loudly instead of returning a refused port', async () => {
  await assert.rejects(
    () => listenAvoidingBlockedPorts(async () => 5060, { attempts: 3 }),
    /no fetchable port after 3 attempts; refused: 5060, 5060, 5060/,
  );
});

// undici keeps sockets alive, so close() alone would wait for them forever.
const shut = (srv) =>
  new Promise((r) => {
    srv.closeAllConnections?.();
    srv.close(() => r());
  });

// A port the tests expect to be REACHABLE must actually answer: closing the
// socket without an HTTP response just makes fetch() hang until it aborts.
function answerOk() {
  return net.createServer((s) => {
    s.once('data', () => {
      s.end('HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok');
    });
  });
}

test('listenEphemeral binds a port fetch() can actually reach', async () => {
  const srv = answerOk();
  const port = await listenEphemeral(srv);
  try {
    assert.ok(!isFetchBlockedPort(port), `${port} must not be a refused port`);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 5000);
    const res = await fetch(`http://127.0.0.1:${port}/`, { signal: ac.signal });
    clearTimeout(timer);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  } finally {
    await shut(srv);
  }
});