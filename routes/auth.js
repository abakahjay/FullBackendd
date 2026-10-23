const express = require("express");
const router = express.Router();
const authMiddleware = require("../middleware/auth.js");


//Import Controllers
const {
    signUp,
    login,
    dashboard,
    userId,
    verifyEmail,
    logout,
    changePassword,
    forgotPassword,
    resetPassword
} = require('../controllers/auth.js');









const { forgotLimiter, resetLimiter } = require("../middleware/passwordResetLimiter.js");
const { loginLimiter, signupLimiter } = require("../middleware/authLimiter.js");
router.post("/forgot-password", forgotLimiter, forgotPassword);
router.post("/reset-password/:token", resetLimiter, resetPassword);
router.post("/reset-password", resetLimiter, resetPassword);

router.route("/signup").post(signupLimiter, signUp)
router.route("/login").post(loginLimiter, login);
router.route("/logout").post(logout);
router.route("/dashboard").get(authMiddleware,dashboard);
router.route("/userId").post(userId);
// Checks the old password, so it is rate limited like a login.
router.route("/:userId").patch(loginLimiter, changePassword);
router.route('/verify-email').get(verifyEmail)

module.exports = router;
