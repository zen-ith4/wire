const multer = require('multer');

function errorHandler(err, req, res, next) {

  if (res.headersSent) {
    return next(err);
  }


  if (err instanceof multer.MulterError) {

    return res.status(400).json({
      error: 'Upload failed'
    });

  }


  const status =
    err.statusCode ||
    err.status ||
    500;


  console.error(err);


  res.status(status).json({
    error:
      status === 500
        ? 'Internal server error'
        : err.message
  });
}


module.exports = {
  errorHandler
};