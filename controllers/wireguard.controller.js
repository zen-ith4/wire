const { exec } = require('child_process');
const { promisify } = require('util');

const constants = require('../config/constants');

const execAsync = promisify(exec);

const {
  getMappedPeer,
  mapPeer: mapPeerService,
  unmapPeer: unmapPeerService,
  listMappedPeers,
} = require('../services/wireguard.service');

const {
  findUserByUsername,
} = require('../services/user.service');

// Was execSync() — a synchronous call that blocks Node's single
// event loop for however long `wg show ... dump` takes (up to the
// 3s timeout). This app's chat is served on that same event loop
// via socket.io, so every admin loading this page stalled message
// delivery/typing/presence for every connected user for the
// duration of the call. Swapping to the async exec() equivalent
// (same shell command, same output parsing, same error handling)
// removes that stall without changing behavior.
async function getPeers(req, res) {
  try {
    const { stdout: wgDump } = await execAsync(
      `wg show ${constants.WG_INTERFACE} dump`,
      {
        encoding: 'utf8',
        timeout: 3000,
      }
    );

    const peers = wgDump
      .trim()
      .split('\n')
      .slice(1)
      .map(line => {
        const parts = line.split('\t');

        if (parts.length < 8) {
          return null;
        }

        const [
          publicKey,
          ,
          ,
          allowedIps,
          handshake,
        ] = parts;

        const mapping = getMappedPeer(publicKey);

        const handshakeSec = Number(handshake);

        return {
          public_key: publicKey,
          username: mapping
            ? mapping.username
            : `${publicKey.slice(0, 12)}…`,
          vpn_ip: allowedIps,
          last_handshake:
            handshakeSec > 0
              ? new Date(handshakeSec * 1000).toISOString()
              : null,
          online:
            handshakeSec > 0 &&
            (Date.now() / 1000 - handshakeSec) < 150,
        };
      })
      .filter(Boolean);

    res.json(peers);

  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: 'Failed to query WireGuard',
    });
  }
}

function getMappedPeers(req, res) {
  res.json(listMappedPeers());
}

function mapPeer(req, res) {
  const {
    public_key,
    username,
  } = req.body || {};

  if (!public_key || !username) {
    return res.status(400).json({
      error: 'public_key and username required',
    });
  }

  const user = findUserByUsername(username);

  if (!user) {
    return res.status(404).json({
      error: 'User not found',
    });
  }

  try {
    mapPeerService(public_key, user.id);

    res.json({
      success: true,
    });

  } catch (err) {
    res.status(409).json({
      error: 'Peer is already mapped',
    });
  }
}

function unmapPeer(req, res) {
  const result = unmapPeerService(req.params.key);

  if (result.changes === 0) {
    return res.status(404).json({
      error: 'Peer not found',
    });
  }

  res.json({
    success: true,
  });
}

module.exports = {
  getPeers,
  getMappedPeers,
  mapPeer,
  unmapPeer,
};