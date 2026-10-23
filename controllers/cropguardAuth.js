const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const validator = require("validator");
const CropGuardUser = require("../models/CropGuardUser.js");
const CropGuardPrediction = require("../models/CropGuardPrediction.js");
const { createToken } = require("../middleware/cropguardAuth.js");
const { deleteImage } = require("../utils/cropguardStorage.js");
const { sendPasswordChanged, sendPasswordReset } = require("../utils/cropguardMail.js");
const {
    BCRYPT_ROUNDS: ROUNDS, Checker, audit, clientIp, config, content, fail, isAllowedRedirect, isStr, passwordProblem,
    rateLimit, toUserDTO,
} = require("../utils/cropguard.js");

const RESET_TTL_MS = 30 * 60 * 1000;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

// A real hash, so a login for an unknown email takes as long as a wrong password.
const dummyHash = bcrypt.hash("timing-equaliser", ROUNDS);

const tokenResponse = (user) => {
    const { token, expiresIn } = createToken(user);
    return { access_token: token, token_type: "bearer", expires_in: expiresIn, user: toUserDTO(user) };
};

const checkRegion = (c, region) => {
    if (region !== undefined && region !== null && region !== "" && !content.regions.includes(region)) {
        c.add("region", "Unknown region");
    }
};

const checkName = (c, name) => {
    if (name !== undefined && name !== null && (!isStr(name) || name.length > 120)) {
        c.add("full_name", "Name must be text of at most 120 characters");
    }
};

// POST /auth/register  { email, password, full_name?, region?, age_confirmed, accept_terms }
const register = async (req, res) => {
    rateLimit(`auth:${clientIp(req)}`, config.authPerMinute);
    const b = req.body || {};
    const c = new Checker();
    if (!isStr(b.email) || !validator.isEmail(b.email.trim())) c.add("email", "Enter a valid email address");
    const pw = passwordProblem(b.password);
    if (pw) c.add("password", pw);
    checkName(c, b.full_name);
    checkRegion(c, b.region);
    if (b.age_confirmed !== true) {
        c.add("age_confirmed", "You must confirm that you meet the minimum age to create an account");
    }
    if (b.accept_terms !== true) c.add("accept_terms", "You must accept the Terms of Use and Privacy notice");
    c.done();

    const email = b.email.trim().toLowerCase();
    if (await CropGuardUser.exists({ email })) {
        throw fail(409, "email_taken", "An account with this email already exists.");
    }
    const now = new Date();
    let user;
    try {
        user = await CropGuardUser.create({
            email,
            passwordHash: await bcrypt.hash(b.password, ROUNDS),
            fullName: b.full_name || null,
            region: b.region || null,
            ageConfirmedAt: now,
            termsAcceptedAt: now,
            termsVersion: config.termsVersion,
        });
    } catch (err) {
        if (err.code === 11000) throw fail(409, "email_taken", "An account with this email already exists.");
        throw err;
    }
    await audit(user._id, "user.register", String(user._id));
    res.status(201).json(tokenResponse(user));
};

// POST /auth/login  { email, password }
const login = async (req, res) => {
    rateLimit(`auth:${clientIp(req)}`, config.authPerMinute);
    const b = req.body || {};
    const c = new Checker();
    if (!isStr(b.email) || !validator.isEmail(b.email.trim())) c.add("email", "Enter a valid email address");
    if (!isStr(b.password) || b.password.length > 200) c.add("password", "Password is required");
    c.done();

    const email = b.email.trim().toLowerCase();
    const user = await CropGuardUser.findOne({ email });
    // Google-only accounts have no password: compare against the dummy so they fail the same way.
    const ok = await bcrypt.compare(b.password, user?.passwordHash || await dummyHash) && Boolean(user?.passwordHash);
    if (!user || !ok || !user.isActive) {
        // Per-account limit on failures, on top of the per-IP limit above.
        rateLimit(`login-fail:${email}`, 10, 15 * 60);
        throw fail(401, "invalid_credentials", "Email or password is incorrect.");
    }
    res.json(tokenResponse(user));
};

// GET /auth/me
const me = async (req, res) => {
    res.json(toUserDTO(req.cropguardUser));
};

// PATCH /auth/me  { full_name?, region?, preferred_language? }
const updateMe = async (req, res) => {
    const b = req.body || {};
    const c = new Checker();
    checkName(c, b.full_name);
    checkRegion(c, b.region);
    if (b.preferred_language !== undefined && b.preferred_language !== null
        && !content.supportedLanguages.includes(b.preferred_language)) {
        c.add("preferred_language", "Unsupported language");
    }
    c.done();

    const user = req.cropguardUser;
    if (b.full_name !== undefined) user.fullName = b.full_name || null;
    if (b.region !== undefined) user.region = b.region || null;
    if (b.preferred_language) user.preferredLanguage = b.preferred_language;
    await user.save();
    res.json(toUserDTO(user));
};

// POST /auth/me/password  { current_password, new_password }  -> 204, signs out every other session
const changePassword = async (req, res) => {
    const b = req.body || {};
    const c = new Checker();
    if (!isStr(b.current_password)) c.add("current_password", "Current password is required");
    const pw = passwordProblem(b.new_password);
    if (pw) c.add("new_password", pw);
    c.done();

    const user = req.cropguardUser;
    if (!user.passwordHash) {
        throw fail(400, "no_password", "This account signs in with Google. Use \"Forgot password\" to add a password.");
    }
    if (!(await bcrypt.compare(b.current_password, user.passwordHash))) {
        throw fail(400, "wrong_password", "Current password is incorrect.");
    }
    user.passwordHash = await bcrypt.hash(b.new_password, ROUNDS);
    user.tokenVersion += 1;
    await user.save();
    await audit(user._id, "user.password_change", String(user._id));
    sendPasswordChanged(user);
    res.status(204).end();
};

// POST /auth/forgot-password  { email, redirect_uri? }  -> always the same 200
// The emailed link is `<redirect_uri>#token=…&email=…` (a fragment, so the secret never
// reaches a server log or Referer). redirect_uri defaults to CROPGUARD_CLIENT_URL/reset-password.
const forgotPassword = async (req, res) => {
    const ip = clientIp(req);
    rateLimit(`forgot:${ip}`, config.forgotPerWindow, 15 * 60);
    const b = req.body || {};
    const c = new Checker();
    if (!isStr(b.email) || !validator.isEmail(b.email.trim())) c.add("email", "Enter a valid email address");
    if (b.redirect_uri !== undefined && (!isStr(b.redirect_uri) || b.redirect_uri.length > 500)) {
        c.add("redirect_uri", "Invalid redirect_uri");
    }
    c.done();

    const redirect = b.redirect_uri || (config.clientUrl && `${config.clientUrl}/reset-password`);
    if (!redirect) throw fail(400, "reset_unavailable", "Password reset is not set up on this server.");
    if (!isAllowedRedirect(redirect)) {
        throw fail(400, "redirect_not_allowed", "redirect_uri is not an allowed site for CropGuard.");
    }

    const email = b.email.trim().toLowerCase();
    rateLimit(`forgot-email:${email}`, 3, 15 * 60);
    const user = await CropGuardUser.findOne({ email });
    if (user && user.isActive) {
        const token = crypto.randomBytes(32).toString("hex");
        user.resetTokenHash = sha256(token);
        user.resetTokenExpires = new Date(Date.now() + RESET_TTL_MS);
        await user.save();
        const link = `${redirect.split("#")[0]}#token=${token}&email=${encodeURIComponent(user.email)}`;
        sendPasswordReset(user, link); // in the background: timing must not reveal whether the account exists
        await audit(user._id, "user.password_reset_requested", String(user._id));
    }
    res.json({ message: "If an account exists for that email, we have sent a link to reset the password." });
};

// POST /auth/reset-password  { email, token, new_password }  -> 200; signs out every session
const resetPassword = async (req, res) => {
    rateLimit(`reset:${clientIp(req)}`, 20, 15 * 60);
    const b = req.body || {};
    const c = new Checker();
    if (!isStr(b.email) || !validator.isEmail(b.email.trim())) c.add("email", "This reset link is incomplete");
    if (!isStr(b.token) || !/^[0-9a-f]{64}$/.test(b.token)) c.add("token", "This reset link is incomplete");
    const pw = passwordProblem(b.new_password);
    if (pw) c.add("new_password", pw);
    c.done();

    const user = await CropGuardUser.findOne({
        email: b.email.trim().toLowerCase(),
        resetTokenHash: sha256(b.token),
        resetTokenExpires: { $gt: new Date() },
    });
    // 400, not 401: clients treat 401 as "session expired".
    if (!user || !user.isActive) {
        throw fail(400, "invalid_reset_link", "This reset link is invalid or has expired. Request a new one.");
    }
    user.passwordHash = await bcrypt.hash(b.new_password, ROUNDS);
    user.resetTokenHash = null;
    user.resetTokenExpires = null;
    user.tokenVersion += 1;
    await user.save();
    await audit(user._id, "user.password_reset", String(user._id));
    sendPasswordChanged(user);
    res.json({ message: "Your password has been reset. You can now sign in." });
};

// Google sign-in. routes/googleAuth.js starts it (?app=cropguard) and calls this from the shared
// callback with the decoded state { redirectUri, consent }. The token goes back in the URL
// fragment (#token=…), errors as #error=….
const googleCallback = async (req, res, state) => {
    const back = (key, value) => res.redirect(`${state.redirectUri.split("#")[0]}#${key}=${encodeURIComponent(value)}`);
    if (!isAllowedRedirect(state.redirectUri)) {
        return res.status(400).json({ detail: { code: "redirect_not_allowed", message: "redirect_uri is not an allowed site." } });
    }
    const { id: googleId, email: rawEmail, fullName } = req.user || {};
    const email = String(rawEmail || "").trim().toLowerCase();
    if (!googleId || !validator.isEmail(email)) return back("error", "Google did not share an email address.");

    let user = await CropGuardUser.findOne({ $or: [{ googleId }, { email }] });
    if (user && !user.isActive) return back("error", "This account has been deactivated.");
    const isOwnerAdmin = config.adminEmails.includes(email);

    if (!user) {
        // New accounts need the same consent as the sign-up form; the web app only starts
        // Google sign-up after the age and terms boxes are ticked.
        if (state.consent !== true) {
            return back("error", "No account for this Google address yet. Create one: tick the two boxes on the sign-up page, then continue with Google.");
        }
        const now = new Date();
        user = await CropGuardUser.create({
            email,
            googleId,
            fullName: fullName ? String(fullName).slice(0, 120) : null,
            role: isOwnerAdmin ? "admin" : "user",
            ageConfirmedAt: now,
            termsAcceptedAt: now,
            termsVersion: config.termsVersion,
        });
        await audit(user._id, "user.register", String(user._id), { via: "google" });
    } else {
        if (!user.googleId) {
            user.googleId = googleId; // Google has verified this address, so the accounts can be linked
            await audit(user._id, "user.google_linked", String(user._id));
        }
        if (isOwnerAdmin && user.role !== "admin") {
            // A password set by someone else before the owner arrived must not keep access.
            user.passwordHash = undefined;
            user.tokenVersion += 1;
            user.role = "admin";
        }
        await user.save();
    }
    return back("token", createToken(user).token);
};

// POST /auth/logout-all  -> 204, revokes every token issued so far
const logoutAll = async (req, res) => {
    req.cropguardUser.tokenVersion += 1;
    await req.cropguardUser.save();
    res.status(204).end();
};

// DELETE /auth/me  { password } (or { confirm: "DELETE" } for Google-only accounts)  -> 204.
// Deletes the account, its predictions and stored images.
const deleteAccount = async (req, res) => {
    const b = req.body || {};
    const user = req.cropguardUser;
    if (!user.passwordHash) {
        if (b.confirm !== "DELETE") throw fail(422, "validation_error", "Type DELETE to confirm", {
            fields: [{ field: "confirm", message: "Type DELETE to confirm" }],
        });
    } else {
        if (!isStr(b.password)) throw fail(422, "validation_error", "Password is required", {
            fields: [{ field: "password", message: "Password is required" }],
        });
        if (!(await bcrypt.compare(b.password, user.passwordHash))) {
            throw fail(400, "wrong_password", "Password is incorrect.");
        }
    }
    const rows = await CropGuardPrediction.find({ userId: user._id }, { imageFileId: 1 });
    for (const p of rows) await deleteImage(p.imageFileId);
    await CropGuardPrediction.deleteMany({ userId: user._id });
    await CropGuardUser.deleteOne({ _id: user._id });
    await audit(null, "user.delete_account", String(user._id));
    res.status(204).end();
};

// Creates or promotes the CROPGUARD_BOOTSTRAP_ADMIN_EMAIL account at startup.
async function bootstrapAdmin() {
    const email = (process.env.CROPGUARD_BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
    const password = process.env.CROPGUARD_BOOTSTRAP_ADMIN_PASSWORD;
    if (!email || !password) return;
    const user = await CropGuardUser.findOne({ email });
    if (!user) {
        if (passwordProblem(password)) {
            console.error("[cropguard] CROPGUARD_BOOTSTRAP_ADMIN_PASSWORD is too weak; admin not created");
            return;
        }
        await CropGuardUser.create({
            email, passwordHash: await bcrypt.hash(password, ROUNDS), role: "admin", fullName: "Administrator",
        });
        console.log("[cropguard] bootstrap administrator created");
    } else if (user.role !== "admin") {
        user.role = "admin";
        await user.save();
    }
}

module.exports = {
    bootstrapAdmin, changePassword, deleteAccount, forgotPassword, googleCallback, login, logoutAll, me, register,
    resetPassword, updateMe,
};
