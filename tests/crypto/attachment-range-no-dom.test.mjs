// The range helpers (and everything they import) must stay free of DOM and
// window APIs.
//
// The same source is bundled into the Service Worker by
// scripts/build-sw-media-bundle.mjs and runs there. A Service Worker has no
// `document`, no `window`, no `localStorage`, no `caches`, no `self`-scoped
// DOM - code that reaches for them would break the bundle (or silently do
// nothing) instead of failing loudly.
//
// Static check: it reads the sources as text, strips the comments and looks for
// forbidden identifiers. No import, no runtime, no browser.
//
//   node --test tests/crypto/attachment-range-no-dom.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const ENTRY = path.join(ROOT, 'public/js/crypto/messages/attachment-range.js');

/*
 * Globals that only exist in a window or a document. A Service Worker has
 * none of them, so the module must not reach for them.
 */
const FORBIDDEN = [
    'document',
    'window',
    'self',
    'localStorage',
    'sessionStorage',
    'navigator',
    'location',
    'history',
    'screen',
    'top',
    'parent',
    'frames',
    'XMLHttpRequest',
    'DOMParser',
    'indexedDB',
    'caches',
    'matchMedia',
    'getComputedStyle',
    'MutationObserver',
    'ResizeObserver',
    'IntersectionObserver',
    'requestAnimationFrame',
    'alert',
    'confirm',
    'prompt',
    'importScripts',
    'postMessage',
    'Worker',
    'SharedWorker',
    'ServiceWorker',
    'Notification',
    'CustomEvent',
    'FormData',
    'HTMLCanvasElement',
    'Image',
    'Audio',
    'Video',
    // The helpers must not do I/O either: the caller hands them the bytes.
    'fetch',
];

/**
 * Removes comments while keeping every other character, so the line numbers
 * of the remaining code stay correct.
 */
function stripComments(source) {
    let out = '';
    let i = 0;
    let state = 'code';

    while (i < source.length) {
        const c = source[i];
        const n = source[i + 1];

        if (state === 'code') {
            if (c === '/' && n === '/') { state = 'line'; i += 2; continue; }
            if (c === '/' && n === '*') { state = 'block'; i += 2; continue; }
            if (c === "'") state = 'single';
            else if (c === '"') state = 'double';
            else if (c === '`') state = 'template';
            out += c;
            i += 1;
            continue;
        }

        if (state === 'line') {
            if (c === '\n') { state = 'code'; out += c; }
            i += 1;
            continue;
        }

        if (state === 'block') {
            if (c === '*' && n === '/') { state = 'code'; i += 2; continue; }
            if (c === '\n') out += c;
            i += 1;
            continue;
        }

        // inside a string literal
        if (c === '\\') { out += c + (n ?? ''); i += 2; continue; }
        if ((state === 'single' && c === "'") ||
            (state === 'double' && c === '"') ||
            (state === 'template' && c === '`')) {
            state = 'code';
        }
        out += c;
        i += 1;
    }

    return out;
}

/** The relative imports of a module, as written in its source. */
function relativeImports(source) {
    const specs = [];
    // `from './x.js'` - the statement may span several lines.
    const from = /from\s*['"](\.\.?\/[^'"]+)['"]/g;
    let m;
    while ((m = from.exec(source)) !== null) specs.push(m[1]);
    // `import './x.js'` - a side-effect import.
    const bare = /(?:^|\n)\s*import\s*['"](\.\.?\/[^'"]+)['"]/g;
    while ((m = bare.exec(source)) !== null) specs.push(m[1]);
    return [...new Set(specs)];
}

/** Every file the entry module pulls in, relative imports only. */
function importGraph(entry) {
    const seen = new Set();
    const queue = [entry];

    while (queue.length) {
        const file = queue.shift();
        if (seen.has(file)) continue;
        seen.add(file);

        const source = fs.readFileSync(file, 'utf8');
        for (const spec of relativeImports(source)) {
            const resolved = path.resolve(path.dirname(file), spec);
            if (!fs.existsSync(resolved)) {
                throw new Error(`import not found: ${spec} (from ${path.relative(ROOT, file)})`);
            }
            queue.push(resolved);
        }
    }

    return [...seen];
}

test('the range module and its imports use no DOM or window API', () => {
    const files = importGraph(ENTRY);

    assert.ok(
        files.length >= 2,
        `the import graph must contain the range module and its import(s), got ${files.length}`
    );
    assert.ok(
        files.includes(ENTRY),
        'the entry module must be part of its own import graph'
    );

    const offenders = [];

    for (const file of files) {
        const source = stripComments(fs.readFileSync(file, 'utf8'));
        const lines = source.split('\n');

        lines.forEach((line, index) => {
            for (const name of FORBIDDEN) {
                const re = new RegExp(`\\b${name}\\b`);
                if (re.test(line)) {
                    offenders.push(
                        `${path.relative(ROOT, file)}:${index + 1} uses "${name}": ${line.trim()}`
                    );
                }
            }
        });
    }

    assert.deepEqual(
        offenders,
        [],
        'these sources are bundled into the Service Worker, which has no DOM:\n' +
        offenders.join('\n')
    );
});

test('the import graph of the range module is the range module plus the stream module', () => {
    const files = importGraph(ENTRY).map((f) => path.relative(ROOT, f).split(path.sep).join('/'));

    assert.deepEqual(
        files.sort(),
        [
            'public/js/crypto/messages/attachment-range.js',
            'public/js/crypto/messages/attachment-stream.js',
        ],
        'the range module must not pull in anything else'
    );
});
