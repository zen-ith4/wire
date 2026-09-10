function sanitizeUrl(req) {
  const url = new URL(
    req.originalUrl || req.url,
    'http://localhost'
  );

  for (const param of [
    'token',
    'access_token',
    'refresh_token'
  ]) {
    url.searchParams.delete(param);
  }

  return url.pathname + url.search;
}


function logger(req, res, next) {

  const start = Date.now();

  res.on('finish', () => {

    const duration = Date.now() - start;

    const user =
      req.user
        ? `USER:${req.user.id}`
        : 'GUEST';

    const ip =
      req.ip || '-';

    console.log(
      `[${new Date().toISOString()}]`,
      ip,
      user,
      req.method,
      sanitizeUrl(req),
      res.statusCode,
      `${duration}ms`
    );

  });

  next();
}


module.exports = {
  logger
};