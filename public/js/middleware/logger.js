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
      req.originalUrl,
      res.statusCode,
      `${duration}ms`
    );

  });


  next();
}


module.exports = {
  logger
};