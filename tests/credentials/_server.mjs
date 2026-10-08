// Boots the REAL server.js on a given database file (always a copy or a fresh
// file, never the committed fixture) and gives tests a tiny HTTP client plus the
// Node twin of the browser's credential derivation.

import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './_fixture.mjs';

// Same secret in this process and in the spawned server, so the fake-salt HMAC matches.
const JWT_SECRET = 'x'.repeat(48);
process.env.JWT_SECRET = JWT_SECRET;
const require = createRequire(import.meta.url);
export const cred = require(path.join(ROOT, 'utils', 'credentials.js'));

export async function bootServer(dbPath, dir, extraEnv = {}) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const port = 39000 + Math.floor(Math.random() * 900);
        const env = {
            ...process.env, DB_PATH: dbPath, USER_DATA_ROOT: path.join(dir, 'user-data'), SETUP_COMPLETED: 'true',
            JWT_SECRET, HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'test',
            EMAIL_ENABLED: 'false', BCRYPT_ROUNDS: '4', ALLOWED_SUBNET: '127.0.0.0/8', ...extraEnv,
        };
        const child = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.stderr.on('data', (d) => { out += d; });
        const ok = await new Promise((resolve) => {
            const t = setTimeout(() => resolve(false), 30000);
            const iv = setInterval(() => { if (out.includes('started successfully')) { clearTimeout(t); clearInterval(iv); resolve(true); } }, 50);
            child.once('exit', () => { clearTimeout(t); clearInterval(iv); resolve(out.includes('started successfully')); });
        });
        const stop = () => new Promise((r) => {
            if (child.exitCode !== null) return r();
            child.once('exit', () => r());
            child.kill('SIGTERM');
            setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        });
        if (ok) {
            const base = `http://127.0.0.1:${port}`;
            const call = async (method, url, { body, token, headers } = {}) => {
                const res = await fetch(base + url, {
                    method,
                    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
                    body: body === undefined ? undefined : JSON.stringify(body),
                });
                let json = null;
                try { json = await res.json(); } catch { /* empty */ }
                return { status: res.status, body: json };
            };
            return { base, call, stop, log: () => out };
        }
        await stop();
        if (!/EADDRINUSE/.test(out)) throw new Error('server did not start:\n' + out);
    }
    throw new Error('no free port');
}

/** Browser-equivalent v2 identity wrapper built in Node (AES-GCM under wrapKey). */
export function wrapIdentityV2(pkcs8B64, publicKeyB64, password, saltB64, iterations = cred.KDF_ITERATIONS) {
    const { authKey, wrapKey } = cred.deriveCredentialsNode(password, saltB64, iterations);
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', wrapKey, iv);
    const ct = Buffer.concat([c.update(Buffer.from(pkcs8B64, 'base64')), c.final(), c.getAuthTag()]);
    return {
        authKey,
        identity: {
            publicKey: publicKeyB64,
            encryptedPrivateKey: ct.toString('base64'),
            kdf: cred.IDENTITY_KDF_NAME,
            kdfParams: { iterations, hash: 'SHA-256' },
            salt: saltB64,
            iv: iv.toString('base64'),
            version: cred.IDENTITY_VERSION,
        },
    };
}

export function unwrapIdentityV2(identity, password) {
    const { wrapKey } = cred.deriveCredentialsNode(password, identity.salt, identity.kdfParams.iterations);
    const raw = Buffer.from(identity.encryptedPrivateKey, 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', wrapKey, Buffer.from(identity.iv, 'base64'));
    d.setAuthTag(raw.subarray(raw.length - 16));
    return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('base64');
}
