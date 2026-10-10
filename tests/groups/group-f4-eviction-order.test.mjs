// F4 (Phase B, B10): the seen-set evicts by (at, counter). A burst of claims that all
// carry the same `at` (a device syncing a long history) must lose the LOWEST counters
// first, and the documented replay window must hold: an evicted nonce is accepted
// again as new, a retained one still conflicts with a different ref.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { installWebLocksPolyfill, newDeviceStorage, useDeviceStorage } from './helpers.mjs';

installWebLocksPolyfill();

const store = await import('../../public/js/crypto/groups/sender-key-store.js');

const KEY = 'evict-key';
// nonce names run OPPOSITE to the counters, so the cursor's primary-key order cannot
// accidentally produce the right eviction order for a sort that ignores the counter
const nonce = (i) => `n${String(999 - i).padStart(3, '0')}`;

test('burst with identical timestamps: lowest counters are evicted first', async () => {
    useDeviceStorage(newDeviceStorage());

    const realNow = Date.now;
    Date.now = () => 1_700_000_000_000; // the whole burst is claimed "in the same millisecond"

    try {
        // inserted in SHUFFLED order so insertion order cannot explain the outcome
        const order = [...Array(40).keys()].sort((a, b) => ((a * 17) % 40) - ((b * 17) % 40));
        for (const i of order) {
            await store.claimNonce({ senderKeyId: KEY, nonceHex: nonce(i), counter: i, ref: `msg:${i}` });
        }
    } finally {
        Date.now = realNow;
    }

    assert.equal(await store.countSeen(KEY), 40);

    await store.pruneSeen(KEY, 20); // cap 20: drop (40-20) + ceil(20/10) = 22 rows -> 18 left

    assert.equal(await store.countSeen(KEY), 18);

    // the 18 highest counters (22..39) survive: same ref -> 'same', different ref -> 'conflict'
    for (const i of [22, 30, 39]) {
        assert.equal(
            await store.claimNonce({ senderKeyId: KEY, nonceHex: nonce(i), counter: i, ref: `msg:${i}` }),
            'same',
            `counter ${i} must be retained`
        );
        assert.equal(
            await store.claimNonce({ senderKeyId: KEY, nonceHex: nonce(i), counter: i, ref: 'replay' }),
            'conflict',
            `retained counter ${i} still detects a replay`
        );
    }

    // the replay window: an EVICTED nonce is accepted again as new (never rejected)
    for (const i of [0, 10, 21]) {
        assert.equal(
            await store.claimNonce({ senderKeyId: KEY, nonceHex: nonce(i), counter: i, ref: 'replayed-under-fresh-id' }),
            'new',
            `counter ${i} was evicted: window documented in the design doc`
        );
    }
});

test('older claim time still goes before a higher counter (at is the primary key)', async () => {
    useDeviceStorage(newDeviceStorage());

    const realNow = Date.now;
    try {
        Date.now = () => 1000;
        for (let i = 100; i < 110; i++) await store.claimNonce({ senderKeyId: 'k2', nonceHex: nonce(i), counter: i, ref: `a:${i}` });
        Date.now = () => 2000;
        for (let i = 0; i < 10; i++) await store.claimNonce({ senderKeyId: 'k2', nonceHex: nonce(i), counter: i, ref: `b:${i}` });
    } finally {
        Date.now = realNow;
    }

    await store.pruneSeen('k2', 10); // 20 rows, drop 10 + 1 -> 9 left, all from the later batch

    assert.equal(await store.countSeen('k2'), 9);
    assert.equal(await store.claimNonce({ senderKeyId: 'k2', nonceHex: nonce(105), counter: 105, ref: 'x' }), 'new', 'earlier batch evicted');
    assert.equal(await store.claimNonce({ senderKeyId: 'k2', nonceHex: nonce(9), counter: 9, ref: 'b:9' }), 'same', 'later batch kept');
});
