const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const validator = require("validator");
const PlatformDeveloper = require("../models/PlatformDeveloper.js");
const { createDeveloperToken } = require("../middleware/platformAuth.js");
const { deleteAppData } = require("./platformApps.js");
const PlatformApp = require("../models/PlatformApp.js");
const { sendReset } = require("../utils/platformMail.js");
const { Checker, clientIp, fail, isStr, limits, passwordProblem, rateLimit, sha256, toDeveloperDTO } = require("../utils/platform.js");

const ROUNDS = 12;
const RESET_TTL_MS = 30 * 60 * 1000;
const dummyHash = bcrypt.hash("timing-equaliser", ROUNDS);
// Reset links open the dashboard on this server; never built from the request's Host header.
const dashboardUrl = () => `${(process.env.ORIGIN || "http://localhost:7004").replace(/\/$/, "")}/developers/`;

const tokenResponse = (d) => ({
    access_token: createDeveloperToken(d), token_type: "bearer", expires_in: limits.tokenMinutes * 60, developer: toDeveloperDTO(d),
});
const checkEmail = (c, email) => {
    if (!isStr(email) || !validator.isEmail(email.trim())) c.add("email", "Enter a valid email address");
};

// POST /platform/auth/register  { email, password, name?, accept_terms }
const register = async (req, res) => {
    rateLimit(`dev-auth:${clientIp(req)}`, limits.authPerMinutePerIp);
    const b = req.body || {};
    const c = new Checker();
    checkEmail(c, b.email);
    const pw = passwordProblem(b.password);
    if (pw) c.add("password", pw);
    if (b.name !== undefined && b.name !== null && (!isStr(b.name) || b.name.length > 120)) c.add("name", "Name: at most 120 characters");
    if (b.accept_terms !== true) c.add("accept_terms", "You must accept the developer terms");
    c.done();
    const email = b.email.trim().toLowerCase();
    if (await PlatformDeveloper.exists({ email })) throw fail(409, "email_taken", "A developer account with this email already exists.");
    let dev;
    try {
        dev = await PlatformDeveloper.create({
            email, passwordHash: await bcrypt.hash(b.password, ROUNDS), name: b.name || null, termsAcceptedAt: new Date(),
        });
    } catch (err) {
        if (err.code === 11000) throw fail(409, "email_taken", "A developer account with this email already exists.");
        throw err;
    }
    res.status(201).json(tokenResponse(dev));
};

// POST /platform/auth/login  { email, password }
const login = async (req, res) => {
    rateLimit(`dev-auth:${clientIp(req)}`, limits.authPerMinutePerIp);
    const b = req.body || {};
    const c = new Checker();
    checkEmail(c, b.email);
    if (!isStr(b.password) || b.password.length > 200) c.add("password", "Password is required");
    c.done();
    const email = b.email.trim().toLowerCase();
    const dev = await PlatformDeveloper.findOne({ email });
    const ok = await bcrypt.compare(b.password, dev ? dev.passwordHash : await dummyHash);
    if (!dev || !ok || !dev.isActive) {
        rateLimit(`dev-login-fail:${email}`, 10, 15 * 60);
        throw fail(401, "invalid_credentials", "Email or password is incorrect.");
    }
    res.json(tokenResponse(dev));
};

const me = async (req, res) => res.json(toDeveloperDTO(req.developer));

// PATCH /platform/auth/me  { name }
const updateMe = async (req, res) => {
    const b = req.body || {};
    if (b.name !== undefined && b.name !== null && (!isStr(b.name) || b.name.length > 120)) {
        throw fail(422, "validation_error", "Name: at most 120 characters", { fields: [{ field: "name", message: "Name: at most 120 characters" }] });
    }
    if (b.name !== undefined) req.developer.name = b.name ? b.name.trim() : null;
    await req.developer.save();
    res.json(toDeveloperDTO(req.developer));
};

// POST /platform/auth/me/password  { current_password, new_password }  -> signs out everywhere
const changePassword = async (req, res) => {
    const b = req.body || {};
    const c = new Checker();
    if (!isStr(b.current_password)) c.add("current_password", "Current password is required");
    const pw = passwordProblem(b.new_password);
    if (pw) c.add("new_password", pw);
    c.done();
    const dev = req.developer;
    if (!(await bcrypt.compare(b.current_password, dev.passwordHash))) throw fail(400, "wrong_password", "Current password is incorrect.");
    dev.passwordHash = await bcrypt.hash(b.new_password, ROUNDS);
    dev.tokenVersion += 1;
    await dev.save();
    res.status(204).end();
};

const logoutAll = async (req, res) => {
    req.developer.tokenVersion += 1;
    await req.developer.save();
    res.status(204).end();
};

// DELETE /platform/auth/me  { password }  -> deletes the developer and every app (users, records, files)
const deleteAccount = async (req, res) => {
    const b = req.body || {};
    if (!isStr(b.password)) throw fail(422, "validation_error", "Password is required", { fields: [{ field: "password", message: "Password is required" }] });
    const dev = req.developer;
    if (!(await bcrypt.compare(b.password, dev.passwordHash))) throw fail(400, "wrong_password", "Password is incorrect.");
    const apps = await PlatformApp.find({ developerId: dev._id });
    for (const a of apps) await deleteAppData(a);
    await PlatformApp.deleteMany({ developerId: dev._id });
    await PlatformDeveloper.deleteOne({ _id: dev._id });
    res.status(204).end();
};

// POST /platform/auth/forgot-password  { email }  -> always the same 200
const forgotPassword = async (req, res) => {
    rateLimit(`dev-forgot:${clientIp(req)}`, 5, 15 * 60);
    const b = req.body || {};
    const c = new Checker();
    checkEmail(c, b.email);
    c.done();
    const email = b.email.trim().toLowerCase();
    rateLimit(`dev-forgot-email:${email}`, 3, 15 * 60);
    const dev = await PlatformDeveloper.findOne({ email });
    if (dev && dev.isActive) {
        const token = crypto.randomBytes(32).toString("hex");
        dev.resetTokenHash = sha256(token);
        dev.resetTokenExpires = new Date(Date.now() + RESET_TTL_MS);
        await dev.save();
        sendReset({
            to: dev.email, name: dev.name, appName: "FullBackendd Developers",
            link: `${dashboardUrl()}#reset&token=${token}&email=${encodeURIComponent(dev.email)}`,
        });
    }
    res.json({ message: "If an account exists for that email, we have sent a link to reset the password." });
};

// POST /platform/auth/reset-password  { email, token, new_password }
const resetPassword = async (req, res) => {
    rateLimit(`dev-reset:${clientIp(req)}`, 20, 15 * 60);
    const b = req.body || {};
    const c = new Checker();
    checkEmail(c, b.email);
    if (!isStr(b.token) || !/^[0-9a-f]{64}$/.test(b.token)) c.add("token", "This reset link is incomplete");
    const pw = passwordProblem(b.new_password);
    if (pw) c.add("new_password", pw);
    c.done();
    const dev = await PlatformDeveloper.findOne({
        email: b.email.trim().toLowerCase(), resetTokenHash: sha256(b.token), resetTokenExpires: { $gt: new Date() },
    });
    if (!dev || !dev.isActive) throw fail(400, "invalid_reset_link", "This reset link is invalid or has expired. Request a new one.");
    dev.passwordHash = await bcrypt.hash(b.new_password, ROUNDS);
    dev.resetTokenHash = null;
    dev.resetTokenExpires = null;
    dev.tokenVersion += 1;
    await dev.save();
    res.json({ message: "Your password has been reset. You can now sign in." });
};

module.exports = { changePassword, deleteAccount, forgotPassword, login, logoutAll, me, register, resetPassword, updateMe };
