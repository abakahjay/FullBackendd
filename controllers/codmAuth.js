const { StatusCodes } = require("http-status-codes");
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const CodmPlayer = require("../models/CodmPlayer.js");
const CodmLoginAttempt = require("../models/CodmLoginAttempt.js");
const { BadRequestError, UnauthenticatedError } = require("../errors");
const { check, toPlayerDTO } = require("../utils/codm.js");
const { normalizeGhanaPhone } = require("../utils/ghana.js");
const { adminEmails } = require("../utils/codmBootstrap.js");

const duplicateMessage = (err) => {
    const field = Object.keys(err.keyValue || err.keyPattern || {})[0];
    return {
        email: "An account with this email already exists. Log in instead.",
        phone: "This phone number is already registered.",
        codmUid: "This CODM UID is already registered.",
    }[field] || "That account already exists.";
};

// POST /api/v1/codm/auth/signup
const signup = async (req, res) => {
    const b = req.body || {};
    const data = {
        fullName: check.text(b.fullName, "Full name", { min: 2, max: 60 }),
        email: check.email(b.email),
        phone: check.phone(b.phone),
        ign: check.ign(b.ign),
        codmUid: check.codmUid(b.codmUid),
    };
    const pw = check.password(b.password);
    if (b.acceptTerms !== true) throw new BadRequestError("Please accept the terms and privacy notice to continue");
    if (b.ageConfirmed !== true) throw new BadRequestError("You must be 16 or older to register");
    if (adminEmails().includes(data.email)) throw new BadRequestError("An account with this email already exists. Log in instead.");

    const player = new CodmPlayer({ ...data, termsAcceptedAt: new Date() }); // role is never taken from the body
    await player.setPassword(pw);
    try {
        await player.save();
    } catch (err) {
        if (err.code === 11000) throw new BadRequestError(duplicateMessage(err));
        throw err;
    }
    res.status(StatusCodes.CREATED).json({ token: player.createJWT(), player: toPlayerDTO(player) });
};

// Wrong-password lockout, per browser session (X-Codm-Session, a random id the
// site keeps in sessionStorage) and per account. After FREE_TRIES wrong
// passwords the account is locked in that session for 30 s; every wrong try
// after a lock doubles it (1 min, 2 min, 4 min ...), up to 1 hour. A new browser
// session starts again from zero, as the organisers asked; the per-IP
// loginLimiter on the route still caps guessing from one network.
const FREE_TRIES = 4;
const BASE_LOCK_MS = 30 * 1000;
const MAX_LOCK_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;
const ACCOUNT_MAX = Number(process.env.CODM_ACCOUNT_LOGIN_FAILURES_PER_15_MIN) || 20;
// bcrypt hash of a random string: compared when the account doesn't exist, so the
// response time doesn't reveal which emails/phones are registered.
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(12).toString("hex"), 12);

const attemptKey = (req, identifier) => {
    const header = req.headers["x-codm-session"];
    const session = typeof header === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(header) ? header : `ip:${req.ip}`;
    return crypto.createHash("sha256").update(`${session}|${identifier.toLowerCase()}`).digest("hex");
};

const waitText = (ms) => {
    const s = Math.ceil(ms / 1000);
    if (s < 60) return `${s} seconds`;
    const m = Math.ceil(s / 60);
    return `${m} minute${m === 1 ? "" : "s"}`;
};

// POST /api/v1/codm/auth/login  { identifier (email or phone), password }
const login = async (req, res) => {
    const b = req.body || {};
    const identifier = typeof b.identifier === "string" ? b.identifier.trim().slice(0, 120) : "";
    if (!identifier || typeof b.password !== "string" || !b.password) {
        throw new BadRequestError("Enter your email or phone and your password");
    }
    const key = attemptKey(req, identifier);
    // Per-account guard that ignores the session header (a client can send a new
    // session id every time): ACCOUNT_MAX wrong passwords in 15 min locks the
    // account for 15 min everywhere.
    const accountKey = crypto.createHash("sha256").update(`account|${identifier.toLowerCase()}`).digest("hex");
    const now = Date.now();
    const [attempt, account] = await Promise.all([
        CodmLoginAttempt.findOne({ key }).lean(),
        CodmLoginAttempt.findOne({ key: accountKey }).lean(),
    ]);
    const lockedUntil = Math.max(attempt?.lockedUntil?.getTime() || 0, account?.lockedUntil?.getTime() || 0);
    if (lockedUntil > now) {
        const wait = lockedUntil - now;
        res.setHeader("Retry-After", Math.ceil(wait / 1000));
        return res.status(429).json({ msg: `Too many wrong passwords. Try again in ${waitText(wait)}.`, retryAfter: Math.ceil(wait / 1000) });
    }

    const asPhone = normalizeGhanaPhone(identifier);
    const player = await CodmPlayer.findOne(asPhone ? { phone: asPhone } : { email: identifier.toLowerCase() });
    // Same answer and similar timing for "no such account" and "wrong password".
    const ok = player && player.isActive ? await player.checkPassword(b.password) : (await bcrypt.compare(b.password, DUMMY_HASH), false);
    if (!ok) {
        const expireAt = new Date(now + DAY_MS);
        // Atomic increments, so parallel guesses can't all read the same count.
        const [session, acct] = await Promise.all([
            CodmLoginAttempt.findOneAndUpdate({ key }, { $inc: { fails: 1 }, $set: { expireAt } }, { upsert: true, new: true }),
            CodmLoginAttempt.findOneAndUpdate(
                { key: accountKey },
                account && account.windowStart > new Date(now - WINDOW_MS)
                    ? { $inc: { fails: 1 }, $set: { expireAt } }
                    : { $set: { fails: 1, windowStart: new Date(now), expireAt } },
                { upsert: true, new: true }
            ),
        ]);
        let lockMsg = "";
        if (session.fails >= FREE_TRIES) {
            const level = (session.lockLevel || 0) + 1;
            const lockMs = Math.min(BASE_LOCK_MS * 2 ** (level - 1), MAX_LOCK_MS);
            await CodmLoginAttempt.updateOne({ key }, { $set: { lockLevel: level, lockedUntil: new Date(now + lockMs) } });
            lockMsg = ` Login is locked for ${waitText(lockMs)}.`;
        }
        if (acct.fails >= ACCOUNT_MAX) {
            await CodmLoginAttempt.updateOne({ key: accountKey }, { $set: { lockedUntil: new Date(now + WINDOW_MS), fails: 0, windowStart: new Date(now) } });
            lockMsg = ` Login is locked for ${waitText(WINDOW_MS)}.`;
        }
        const left = FREE_TRIES - session.fails;
        throw new UnauthenticatedError(`Invalid email/phone or password.${lockMsg || (left > 0 && left < FREE_TRIES - 1 ? ` ${left} tr${left === 1 ? "y" : "ies"} left before a short lock.` : "")}`);
    }
    await CodmLoginAttempt.deleteOne({ key });
    res.status(StatusCodes.OK).json({ token: player.createJWT(), player: toPlayerDTO(player) });
};

// GET /api/v1/codm/auth/me
const me = async (req, res) => {
    res.status(StatusCodes.OK).json({ player: toPlayerDTO(req.player) });
};

// PATCH /api/v1/codm/auth/me  { fullName?, ign?, phone? }
const updateMe = async (req, res) => {
    const b = req.body || {};
    const p = req.player;
    if (b.fullName !== undefined) p.fullName = check.text(b.fullName, "Full name", { min: 2, max: 60 });
    if (b.ign !== undefined) p.ign = check.ign(b.ign);
    if (b.phone !== undefined) p.phone = check.phone(b.phone);
    try {
        await p.save();
    } catch (err) {
        if (err.code === 11000) throw new BadRequestError(duplicateMessage(err));
        throw err;
    }
    res.status(StatusCodes.OK).json({ player: toPlayerDTO(p) });
};

// POST /api/v1/codm/auth/change-password  { currentPassword, newPassword }
const changePassword = async (req, res) => {
    const b = req.body || {};
    const p = req.player;
    if (typeof b.currentPassword !== "string" || !(await p.checkPassword(b.currentPassword))) {
        throw new BadRequestError("Your current password is not correct"); // 400, not 401: keeps the session
    }
    await p.setPassword(check.password(b.newPassword, "New password"));
    p.tokenVersion += 1; // logs out every other device
    await p.save();
    res.status(StatusCodes.OK).json({ token: p.createJWT(), player: toPlayerDTO(p) });
};

module.exports = { signup, login, me, updateMe, changePassword };
