// routes/version.routes.js

const express = require('express');
const packageJson = require('../package.json');

const router = express.Router();

router.get('/', (_req, res) => {
    res.json({
        version: packageJson.version,
    });
});

module.exports = router;