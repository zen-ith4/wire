const { authenticateUser } = require('../services/auth.service');
const { clearLoginAttempts } = require('../middleware/rateLimiter');


async function login(req, res) {

  const username =
    req.body?.username?.trim();

  const password =
    req.body?.password;


  if (!username || !password) {
    return res.status(400).json({
      error: 'Username and password required'
    });
  }


  const result = await authenticateUser(
    username,
    password
  );


  if (!result) {
    return res.status(401).json({
      error: 'Invalid credentials'
    });
  }


  clearLoginAttempts(
    req.ip,
    username
  );


  res.json(result);
}


module.exports = {
  login
};