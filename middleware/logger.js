function sanitizePath(req) {
  // Log only the URL pathname.
  // Query strings may contain filenames, paths, tokens, IDs,
  // search terms, or other user-controlled/private data.
  return req.path || '/';
}


function getUserLabel(req) {
  if (req.user?.id !== undefined && req.user?.id !== null) {
    return `USER:${req.user.id}`;
  }

  return 'GUEST';
}


function getClientIp(req) {
  // Keep the existing Express-resolved IP.
  // Do not log forwarded headers directly because they can contain
  // user-controlled values and may expose unnecessary network data.
  return req.ip || '-';
}


function logger(req, res, next) {
  const start = process.hrtime.bigint();

  res.on('finish', () => {
    const durationMs =
      Number(process.hrtime.bigint() - start) / 1_000_000;

    const timestamp = new Date().toISOString();
    const ip = getClientIp(req);
    const user = getUserLabel(req);
    const method = req.method;
    const path = sanitizePath(req);
    const status = res.statusCode;

    console.log(
      `[${timestamp}]`,
      ip,
      user,
      method,
      path,
      status,
      `${Math.round(durationMs)}ms`
    );
  });

  next();
}


module.exports = {
  logger
};