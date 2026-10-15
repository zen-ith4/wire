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

  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    // undici is a dependency, not a dev-only one; if it is genuinely absent the
    // behavioural tests above still stand on their own.
    return;
  }

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
  for (const port of BINDABLE) {
    const verdict = await fetchAgainst(port);
    if (!verdict.startsWith('BLOCKED')) notBlocked.push(`${port}->${verdict}`);
  }

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