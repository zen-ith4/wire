const express = require('express');

const router = express.Router();

const {
  authenticate,
  adminOnly,
} = require('../middleware/authenticate');

const {
  getPeers,
  getMappedPeers,
  mapPeer,
  unmapPeer,
} = require('../controllers/wireguard.controller');


// All routes require admin authentication.
router.use(
  authenticate,
  adminOnly
);


// Live WireGuard peers
router.get(
  '/',
  getPeers
);


// Database mappings
router.get(
  '/peers',
  getMappedPeers
);

router.post(
  '/peers',
  mapPeer
);

router.delete(
  '/peers/:key',
  unmapPeer
);


module.exports = router;