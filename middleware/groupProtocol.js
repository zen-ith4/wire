// F7: explicit "update required" for stale clients.
//
// Group E2EE protocol 2 (v:2 KDMs, key-derived sender key ids, per-device
// receipts) is not understood by older JS, including copies bundled into
// Capacitor builds. Such a client would fetch v:2 KDMs, fail to parse them and
// show endless "waiting for key" placeholders. Instead the server answers
// 426 with a machine-readable body, so the client can show a real message.
//
// The client declares its protocol in `X-Wire-Group-Proto` (see core/api.js).
// A missing header means "older than the header itself" and is gated too.
//
// Only endpoints that carry KDMs or ciphertext are gated; group management
// stays reachable so a stale app can still render its explanation.

const GROUP_PROTOCOL_MIN = 2;

function requireGroupProtocol(req, res, next) {
  const declared = Number.parseInt(req.get('x-wire-group-proto'), 10);

  if (Number.isInteger(declared) && declared >= GROUP_PROTOCOL_MIN) {
    return next();
  }

  return res.status(426).json({
    error: 'This app version is too old for encrypted groups. Please update.',
    code: 'update_required',
    min_group_protocol: GROUP_PROTOCOL_MIN,
  });
}

module.exports = { requireGroupProtocol, GROUP_PROTOCOL_MIN };
