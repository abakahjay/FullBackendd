const express = require("express");
const authMiddleware = require('../middleware/auth');
const router = express.Router();
const { initiateBundle } = require("../controllers/muviinContoller");

// POST /api/v1/muviin/initiate
// Sends a MoMo debit prompt to any number: signed-in users only (afrodata.html sends the cookie).
router.post("/initiate", authMiddleware, initiateBundle);

module.exports = router;
