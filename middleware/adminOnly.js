function adminOnly(req, res, next) {

  if (!req.user) {
    return res.status(401).json({
      error: 'Unauthorized'
    });
  }


  if (!req.user.is_admin) {
    return res.status(403).json({
      error: 'Admin access required'
    });
  }


  next();
}


module.exports = {
  adminOnly
};