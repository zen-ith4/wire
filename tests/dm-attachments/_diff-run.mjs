// Same request sequence against a tree; writes normalized [status, body] to OUT.
import './_env.mjs';
if (process.env.DIFF_FLAG) process.env.DM_E2EE_ATTACHMENTS_ENFORCED = process.env.DIFF_FLAG;
import fs from 'node:fs';
import { startDmServer, createUser, authGet } from './_harness.mjs';
const OUT = process.env.DIFF_OUT;
const server = await startDmServer();
const a = await createUser(server, 'alice');
const b = await createUser(server, 'bob');
const log = [];
const norm = (v) => {
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  if (typeof v === 'string') {
    if (/^\d{4}-\d\d-\d\dT/.test(v) || /^\d{4}-\d\d-\d\d \d\d:/.test(v)) return '<ts>';
    if (v.includes('"encryption"')) return '<enc>';
    if (v.length > 24 && /^[A-Za-z0-9+/=_.-]+$/.test(v)) return '<b64>';
  }
  return v;
};
async function rec(label, res) {
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  log.push({ label, status: res.status, body: norm(body), ct: res.headers.get('content-type') });
  return body;
}
const J = (u, method, path, data) => globalThis.__nodeFetch(`${server.origin}${path}`, { method, headers: { Authorization: `Bearer ${u.token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) }, body: data ? JSON.stringify(data) : undefined });
async function enc(u, peer, text) {
  u.actor.use();
  const m = await u.actor.importModule('crypto/messages/message-crypto.js');
  return JSON.stringify(await m.encryptOutgoingMessage(text, u.id, peer.id));
}
await rec('conversations-empty', await authGet(server, a, '/api/dm/conversations'));
await rec('unread-empty', await authGet(server, b, '/api/dm/unread-count'));
const t1 = await rec('send-text', await J(a, 'POST', '/api/dm/messages', { recipient_id: b.id, content: await enc(a, b, 'one') }));
await rec('send-reply', await J(b, 'POST', '/api/dm/messages', { recipient_id: a.id, content: await enc(b, a, 'two'), reply_to_id: t1.id }));
await rec('send-empty', await J(a, 'POST', '/api/dm/messages', { recipient_id: b.id, content: '' }));
await rec('send-self', await J(a, 'POST', '/api/dm/messages', { recipient_id: a.id, content: await enc(a, a, 'x') }));
await rec('send-bad-recipient', await J(a, 'POST', '/api/dm/messages', { recipient_id: 9999, content: 'x' }));
await rec('recent', await authGet(server, b, `/api/dm/messages/${a.id}/recent`));
await rec('before', await authGet(server, b, `/api/dm/messages/${a.id}/before?before_id=999`));
await rec('since', await authGet(server, b, `/api/dm/messages/${a.id}/since?after_id=0`));
await rec('react', await J(b, 'POST', `/api/dm/messages/${t1.id}/reactions`, { emoji: '👍' }));
await rec('recent-after-react', await authGet(server, a, `/api/dm/messages/${b.id}/recent`));
await rec('conversations', await authGet(server, a, '/api/dm/conversations'));
await rec('unread', await authGet(server, a, '/api/dm/unread-count'));
await rec('edit', await J(a, 'PATCH', `/api/dm/messages/${t1.id}`, { content: await enc(a, b, 'edited') }));
await rec('edit-forbidden', await J(b, 'PATCH', `/api/dm/messages/${t1.id}`, { content: await enc(b, a, 'x') }));
await rec('attachment-404', await authGet(server, a, '/api/dm/attachments/9999'));
await rec('media-token-404', await authGet(server, a, '/api/dm/attachments/9999/media-token'));
await rec('unauth', await globalThis.__nodeFetch(`${server.origin}/api/dm/conversations`));
// plaintext upload (legacy path): expected to differ ONLY when enforcement is ON
const form = () => { const f = new FormData(); f.append('file', new File([Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64'))], 'p.png', { type: 'image/png' }), 'p.png'); f.append('recipient_id', String(b.id)); f.append('content', 'plain caption'); return f; };
const up = await rec('plaintext-upload', await globalThis.__nodeFetch(`${server.origin}/api/dm/upload`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}` }, body: form() }));
if (up && up.id) {
  await rec('legacy-attachment-get', await authGet(server, b, `/api/dm/attachments/${up.id}`));
  await rec('legacy-attachment-range', await authGet(server, b, `/api/dm/attachments/${up.id}`, { Range: 'bytes=0-9' }));
  await rec('legacy-media-token', await authGet(server, b, `/api/dm/attachments/${up.id}/media-token`));
  await rec('legacy-recent', await authGet(server, b, `/api/dm/messages/${a.id}/recent`));
  await rec('legacy-conversations', await authGet(server, b, '/api/dm/conversations'));
  await rec('legacy-delete', await J(a, 'DELETE', `/api/dm/messages/${up.id}`));
}
await rec('delete-text', await J(a, 'DELETE', `/api/dm/messages/${t1.id}`));
fs.writeFileSync(OUT, JSON.stringify(log, null, 1));
process.exit(0);
