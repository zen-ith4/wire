const ipaddr = require('ipaddr.js');
const constants = require('../config/constants');

// ALLOWED_SUBNET is a static config value — it never changes at
// runtime, so there's no reason to re-parse the CIDR string on
// every single request (this ran on literally every request that
// reached the app, including every static asset). Parse it once at
// module load instead; the actual per-request cost is now just the
// address parse + match, which is what should scale with traffic.
const [allowedRange, allowedBits] =
  ipaddr.parseCIDR(constants.ALLOWED_SUBNET);

function ipRestrict(req, res, next) {

  try {

    const ip = req.ip.replace(/^::ffff:/, '');

    const addr = ipaddr.parse(ip);


    if (addr.kind() !== allowedRange.kind()) {
      return res.status(403).json({
        error: 'IP family mismatch'
      });
    }


    if (addr.match([allowedRange, allowedBits])) {
      return next();
    }


    return res.status(403).json({
      error: 'Access denied'
    });


  } catch (e) {

    return res.status(403).json({
      error: 'Access denied'
    });

  }
}


module.exports = {
  ipRestrict
};