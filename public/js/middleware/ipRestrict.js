const ipaddr = require('ipaddr.js');
const constants = require('../config/constants');

function ipRestrict(req, res, next) {

  try {

    const ip = req.ip.replace(/^::ffff:/, '');

    const addr = ipaddr.parse(ip);

    const [range, bits] =
      ipaddr.parseCIDR(constants.ALLOWED_SUBNET);


    if (addr.kind() !== range.kind()) {
      return res.status(403).json({
        error: 'IP family mismatch'
      });
    }


    if (addr.match([range, bits])) {
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