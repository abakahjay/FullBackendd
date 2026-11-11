const express = require("express");
const helmet = require("helmet");
const rateLimiter = require("express-rate-limit");
const codmAuth = require("../middleware/codmAuth.js");
const { requireCodmAdmin } = require("../middleware/codmAuth.js");
const auth = require("../controllers/codmAuth.js");
const teams = require("../controllers/codmTeams.js");
const payments = require("../controllers/codmPayments.js");
const admin = require("../controllers/codmAdmin.js");
const bracket = require("../controllers/codmBracket.js");
require("../utils/codmBootstrap.js"); // creates the organiser accounts from env at startup

// CODM Campus Showdown (UMaT Call of Duty: Mobile tournament): /api/v1/codm/*
//
// Mounted in app.js BEFORE the global body parsers / xss-clean / mongo-sanitize,
// like CropGuard: this router parses its own bodies (small JSON only, raw bytes
// for the Paystack webhook) and every controller type-checks its input
// (utils/codm.js `check`) before it reaches a query. Errors are the usual
// errors/* classes, answered by the global error handler as { msg }.
const router = express.Router();

router.use(helmet());
router.use(rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.CODM_RATE_LIMIT_PER_15_MIN) || 600,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: "Too many requests. Please slow down and try again shortly." },
}));

// Raw body for the webhook signature (must come before the JSON parser).
router.post("/payments/webhook", express.raw({ type: "application/json", limit: "200kb" }), payments.webhook);
router.use(express.json({ limit: "20kb" }));

// Failed logins per network. Generous on purpose: a whole hall on campus Wi-Fi
// shares one IP. Per-account guessing is stopped by the lockout in codmAuth.login.
const loginLimiter = rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: Number(process.env.CODM_LOGIN_FAILURES_PER_15_MIN) || 150,
    skipSuccessfulRequests: true,
    keyGenerator: (req) => `${req.ip}|codm-login`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: "Too many failed logins from this network. Please wait 15 minutes." },
});

// Sign-ups per network: generous (campus Wi-Fi shares one IP).
const signupLimiter = rateLimiter({
    windowMs: 60 * 60 * 1000,
    max: Number(process.env.CODM_SIGNUPS_PER_HOUR) || 400,
    keyGenerator: (req) => `${req.ip}|codm-signup`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: "Too many sign-ups from this network. Please try again in a while." },
});

// Per player (these run after codmAuth), so one person can't block a whole hall.
const joinLimiter = rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 30,
    keyGenerator: (req) => `${req.player._id}|codm-join`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: "Too many invite-code attempts. Please wait 15 minutes." },
});

const paymentLimiter = rateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    keyGenerator: (req) => `${req.player._id}|codm-pay`,
    standardHeaders: true,
    legacyHeaders: false,
    message: { msg: "Too many payment attempts. Please wait a few minutes." },
});

// Public
router.get("/event", teams.getEvent);
router.get("/teams", teams.listTeams);
router.get("/bracket", bracket.getBracket);

// Accounts
router.post("/auth/signup", signupLimiter, auth.signup);
router.post("/auth/login", loginLimiter, auth.login);
router.get("/auth/me", codmAuth, auth.me);
router.patch("/auth/me", codmAuth, auth.updateMe);
router.post("/auth/change-password", codmAuth, loginLimiter, auth.changePassword);

// Teams
router.get("/teams/mine", codmAuth, teams.getMyTeam);
router.post("/teams", codmAuth, teams.createTeam);
router.post("/teams/join", codmAuth, joinLimiter, teams.joinTeam);
router.post("/teams/leave", codmAuth, teams.leaveTeam);
router.patch("/teams/mine", codmAuth, teams.updateMyTeam);
router.post("/teams/mine/invite-code", codmAuth, teams.regenerateInviteCode);
router.delete("/teams/mine/members/:playerId", codmAuth, teams.removeMember);

// Entry fee (Paystack)
router.post("/payments/initialize", codmAuth, paymentLimiter, payments.initializePayment);
router.get("/payments/verify/:reference", codmAuth, payments.verifyPayment);

// Organisers
router.get("/admin/overview", codmAuth, requireCodmAdmin, admin.overview);
router.get("/admin/export.csv", codmAuth, requireCodmAdmin, admin.exportCsv);
router.patch("/admin/players/:playerId/paid", codmAuth, requireCodmAdmin, admin.setPaid);
router.post("/admin/bracket/generate", codmAuth, requireCodmAdmin, bracket.generateBracket);
router.patch("/admin/bracket/matches/:matchId", codmAuth, requireCodmAdmin, bracket.updateMatch);
router.delete("/admin/bracket", codmAuth, requireCodmAdmin, bracket.resetBracket);

module.exports = router;
