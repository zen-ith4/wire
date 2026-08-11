function asyncHandler(fn) {

  if (typeof fn !== 'function') {
    throw new TypeError(
      'asyncHandler expects a function'
    );
  }

  return (req, res, next) => {
    Promise
      .resolve(fn(req, res, next))
      .catch(next);
  };
}


module.exports = {
  asyncHandler
};