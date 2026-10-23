const rateLimiter = require("express-rate-limit");

// Brute-force protection for sign-in style endpoints of every app (shared users,
// SeedBridge, CleanBridge). Counted per client IP *and* route, so one app's
// traffic can't use up another's budget. Needs `trust proxy` on Render (app.js),
// otherwise every visitor shares the proxy's IP.
const perRoute = (req) => `${req.ip}|${req.baseUrl}${req.path}`;
const message = { msg: "Too many attempts. Please wait 15 minutes and try again." };

// Failed logins / password checks: only failures count, so normal users never hit it.
const loginLimiter = rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.LOGIN_FAILURES_PER_15_MIN) || 25,
    skipSuccessfulRequests: true,
    keyGenerator: perRoute,
    standardHeaders: true,
    legacyHeaders: false,
    message,
});

// Account creation: generous, but stops scripted mass sign-ups.
const signupLimiter = rateLimiter({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.SIGNUPS_PER_HOUR) || 60,
    keyGenerator: perRoute,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: "Too many accounts created from this network. Please try again later." },
});

module.exports = { loginLimiter, signupLimiter };
