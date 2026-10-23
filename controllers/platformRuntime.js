const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const validator = require("validator");
const PlatformAppUser = require("../models/PlatformAppUser.js");
const PlatformRecord = require("../models/PlatformRecord.js");
const { createAppUserToken } = require("../middleware/platformAuth.js");
const { sendReset } = require("../utils/platformMail.js");
const { findFile, openFile, removeFile, saveFile } = require("../utils/platformStorage.js");
const {
    Checker, clientIp, collectionToDTO, fail, filterValue, isLocalOrigin, isStr, limits, originOf, passwordProblem,
    rateLimit, sha256, toAppUserDTO, toRecordDTO, validateRecord,
} = require("../utils/platform.js");

// The generated API every platform app gets: /api/v1/apps/<slug>/*
// platformAppContext (middleware/platformAuth.js) has already resolved the app, checked
// its key and the caller's origin, and set req.platformRole to public | user | admin.

const ROUNDS = 12;
const RESET_TTL_MS = 30 * 60 * 1000;
const dummyHash = bcrypt.hash("timing-equaliser", ROUNDS);

const authOn = (app) => {
    if (app.features?.auth === false) throw fail(404, "feature_off", "User accounts are turned off for this app.");
};
const checkEmail = (c, email) => {
    if (!isStr(email) || email.length > 254 || !validator.isEmail(email.trim())) c.add("email", "Enter a valid email address");
};

// ---------- docs ----------
// GET /docs  -> what this app's API offers (no key needed: it contains no data)
const docs = (req, res) => {
    const app = req.platformApp;
    const base = `/api/v1/apps/${app.slug}`;
    const endpoints = [];
    if (app.features?.auth !== false) {
        endpoints.push(
            ["POST", `${base}/auth/register`, "public", "{ email, password, name? } -> { access_token, user }"],
            ["POST", `${base}/auth/login`, "public", "{ email, password } -> { access_token, user }"],
            ["GET", `${base}/auth/me`, "user", "The signed-in user"],
            ["PATCH", `${base}/auth/me`, "user", "{ name }"],
            ["POST", `${base}/auth/me/password`, "user", "{ current_password, new_password } (signs out other sessions)"],
            ["DELETE", `${base}/auth/me`, "user", "{ password } deletes the account and its records"],
            ["POST", `${base}/auth/forgot-password`, "public", "{ email, redirect_uri } emails <redirect_uri>#token=&email="],
            ["POST", `${base}/auth/reset-password`, "public", "{ email, token, new_password }"],
        );
    }
    if (app.features?.files) {
        endpoints.push(
            ["POST", `${base}/files`, "user", `multipart "file" (image or PDF, max ${limits.fileMb} MB) -> { id, url }`],
            ["GET", `${base}/files/:id`, "public (by link)", "The file"],
            ["DELETE", `${base}/files/:id`, "owner", "Delete a file you uploaded"],
        );
    }
    for (const col of app.collections) {
        const p = `${base}/data/${col.name}`;
        endpoints.push(
            ["GET", p, col.access.read, "List: ?page=&page_size=(<=100)&sort=field|-field&<field>=<value>"],
            ["POST", p, col.access.create, "Create a record"],
            ["GET", `${p}/:id`, col.access.read, "One record"],
            ["PATCH", `${p}/:id`, col.access.update, "Change some fields"],
            ["DELETE", `${p}/:id`, col.access.delete, "Delete"],
        );
    }
    res.json({
        app: { name: app.name, slug: app.slug },
        headers: {
            "X-App-Key": "the app's publishable key (required, except with the secret key)",
            Authorization: "Bearer <access_token> for signed-in users, or Bearer <secret key> from your server only",
        },
        access_rules: {
            public: "anyone with the app key", signed_in: "any signed-in user of this app", owner: "the user who created the record",
            admin: "only your server, with the secret key",
        },
        errors: '{ "detail": { "code", "message", "fields?" } }; 422 = invalid input (see fields)',
        endpoints: endpoints.map(([method, path, access, notes]) => ({ method, path, access, notes })),
        collections: app.collections.map(collectionToDTO),
    });
};

// ---------- end-user auth ----------
const userResponse = (u, app) => ({
    access_token: createAppUserToken(u, app), token_type: "bearer", expires_in: limits.tokenMinutes * 60, user: toAppUserDTO(u),
});

const register = async (req, res) => {
    const app = req.platformApp;
    authOn(app);
    rateLimit(`app-auth:${app._id}:${clientIp(req)}`, limits.authPerMinutePerIp);
    const b = req.body || {};
    const c = new Checker();
    checkEmail(c, b.email);
    const pw = passwordProblem(b.password);
    if (pw) c.add("password", pw);
    if (b.name !== undefined && b.name !== null && (!isStr(b.name) || b.name.length > 120)) c.add("name", "Name: at most 120 characters");
    c.done();
    if (await PlatformAppUser.countDocuments({ appId: app._id }) >= limits.usersPerApp) {
        throw fail(403, "user_limit", "This app has reached its user limit.");
    }
    const email = b.email.trim().toLowerCase();
    let user;
    try {
        user = await PlatformAppUser.create({ appId: app._id, email, passwordHash: await bcrypt.hash(b.password, ROUNDS), name: b.name || null });
    } catch (err) {
        if (err.code === 11000) throw fail(409, "email_taken", "An account with this email already exists.");
        throw err;
    }
    res.status(201).json(userResponse(user, app));
};

const login = async (req, res) => {
    const app = req.platformApp;
    authOn(app);
    rateLimit(`app-auth:${app._id}:${clientIp(req)}`, limits.authPerMinutePerIp);
    const b = req.body || {};
    const c = new Checker();
    checkEmail(c, b.email);
    if (!isStr(b.password) || b.password.length > 200) c.add("password", "Password is required");
    c.done();
    const email = b.email.trim().toLowerCase();
    const user = await PlatformAppUser.findOne({ appId: app._id, email });
    const ok = await bcrypt.compare(b.password, user ? user.passwordHash : await dummyHash);
    if (!user || !ok || !user.isActive) {
        rateLimit(`app-login-fail:${app._id}:${email}`, 10, 15 * 60);
        throw fail(401, "invalid_credentials", "Email or password is incorrect.");
    }
    res.json(userResponse(user, app));
};

const me = (req, res) => res.json(toAppUserDTO(req.appUser));

const updateMe = async (req, res) => {
    const b = req.body || {};
    if (b.name !== undefined && b.name !== null && (!isStr(b.name) || b.name.length > 120)) {
        throw fail(422, "validation_error", "Name: at most 120 characters", { fields: [{ field: "name", message: "Name: at most 120 characters" }] });
    }
    if (b.name !== undefined) req.appUser.name = b.name || null;
    await req.appUser.save();
    res.json(toAppUserDTO(req.appUser));
};

const changePassword = async (req, res) => {
    const b = req.body || {};
    const c = new Checker();
    if (!isStr(b.current_password)) c.add("current_password", "Current password is required");
    const pw = passwordProblem(b.new_password);
    if (pw) c.add("new_password", pw);
    c.done();
    const u = req.appUser;
    if (!(await bcrypt.compare(b.current_password, u.passwordHash))) throw fail(400, "wrong_password", "Current password is incorrect.");
    u.passwordHash = await bcrypt.hash(b.new_password, ROUNDS);
    u.tokenVersion += 1;
    await u.save();
    res.json(userResponse(u, req.platformApp)); // a fresh token for this device
};

const deleteMe = async (req, res) => {
    const b = req.body || {};
    if (!isStr(b.password)) throw fail(422, "validation_error", "Password is required", { fields: [{ field: "password", message: "Password is required" }] });
    const u = req.appUser;
    if (!(await bcrypt.compare(b.password, u.passwordHash))) throw fail(400, "wrong_password", "Password is incorrect.");
    await PlatformRecord.deleteMany({ appId: req.platformApp._id, ownerId: u._id });
    await PlatformAppUser.deleteOne({ _id: u._id });
    res.status(204).end();
};

// The reset link may only point at one of the app's own frontends.
function allowedRedirect(app, url) {
    const o = isStr(url) ? originOf(url) : null;
    return Boolean(o && (app.frontendOrigins.includes(o) || (app.allowLocalhost && isLocalOrigin(o))));
}

const forgotPassword = async (req, res) => {
    const app = req.platformApp;
    authOn(app);
    rateLimit(`app-forgot:${app._id}:${clientIp(req)}`, 5, 15 * 60);
    const b = req.body || {};
    const c = new Checker();
    checkEmail(c, b.email);
    if (!allowedRedirect(app, b.redirect_uri)) c.add("redirect_uri", "redirect_uri must be a page on one of this app's frontend URLs");
    c.done();
    const email = b.email.trim().toLowerCase();
    rateLimit(`app-forgot-email:${app._id}:${email}`, 3, 15 * 60);
    const user = await PlatformAppUser.findOne({ appId: app._id, email });
    if (user && user.isActive) {
        const token = crypto.randomBytes(32).toString("hex");
        user.resetTokenHash = sha256(token);
        user.resetTokenExpires = new Date(Date.now() + RESET_TTL_MS);
        await user.save();
        sendReset({ to: user.email, name: user.name, appName: app.name, link: `${b.redirect_uri.split("#")[0]}#token=${token}&email=${encodeURIComponent(user.email)}` });
    }
    res.json({ message: "If an account exists for that email, we have sent a link to reset the password." });
};

const resetPassword = async (req, res) => {
    const app = req.platformApp;
    authOn(app);
    rateLimit(`app-reset:${app._id}:${clientIp(req)}`, 20, 15 * 60);
    const b = req.body || {};
    const c = new Checker();
    checkEmail(c, b.email);
    if (!isStr(b.token) || !/^[0-9a-f]{64}$/.test(b.token)) c.add("token", "This reset link is incomplete");
    const pw = passwordProblem(b.new_password);
    if (pw) c.add("new_password", pw);
    c.done();
    const user = await PlatformAppUser.findOne({
        appId: app._id, email: b.email.trim().toLowerCase(), resetTokenHash: sha256(b.token), resetTokenExpires: { $gt: new Date() },
    });
    if (!user || !user.isActive) throw fail(400, "invalid_reset_link", "This reset link is invalid or has expired. Request a new one.");
    user.passwordHash = await bcrypt.hash(b.new_password, ROUNDS);
    user.resetTokenHash = null;
    user.resetTokenExpires = null;
    user.tokenVersion += 1;
    await user.save();
    res.json({ message: "Your password has been reset. You can now sign in." });
};

// ---------- data ----------
function collectionOf(req) {
    const col = req.platformApp.collections.find((c) => c.name === req.params.collection);
    if (!col) throw fail(404, "not_found", "No such collection.");
    return col;
}

/** Throws unless the caller passes `rule`; returns an extra query filter for "owner" reads. */
function allow(req, rule) {
    const role = req.platformRole;
    if (role === "admin") return {};
    if (rule === "public") return {};
    if (rule === "admin") throw fail(403, "forbidden", "Only the app's server can do this.");
    if (!req.appUser) throw fail(401, "unauthorized", "Sign in to this app first.", { headers: { "WWW-Authenticate": "Bearer" } });
    if (rule === "owner") return { ownerId: req.appUser._id };
    return {};
}

const recordId = (req) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw fail(404, "not_found", "Record not found.");
    return req.params.id;
};
const scope = (req, col) => ({ appId: req.platformApp._id, collectionName: col.name });
// Only the current schema's fields are returned (fields removed later stay hidden).
const present = (col, r) => {
    const d = toRecordDTO(r);
    const keep = new Set(["id", "owner_id", "created_at", "updated_at", ...col.fields.map((f) => f.name)]);
    return Object.fromEntries(Object.entries(d).filter(([k]) => keep.has(k)));
};

const listRecords = async (req, res) => {
    const col = collectionOf(req);
    const q = { ...scope(req, col), ...allow(req, col.access.read) };
    const c = new Checker();
    const byName = Object.fromEntries(col.fields.map((f) => [f.name, f]));
    for (const [k, raw] of Object.entries(req.query)) {
        if (["page", "page_size", "sort"].includes(k)) continue;
        const f = byName[k];
        if (!f) {
            c.add(k, `Unknown filter "${k}"`);
            continue;
        }
        const v = filterValue(f, Array.isArray(raw) ? raw[0] : raw);
        if (v.error) c.add(k, `${k}: ${v.error}`);
        else q[`data.${k}`] = v.value; // typed scalar: never an operator object
    }
    const page = Math.max(1, Math.min(10000, parseInt(req.query.page, 10) || 1));
    const size = Math.max(1, Math.min(100, parseInt(req.query.page_size, 10) || 20));
    let sort = { createdAt: -1 };
    if (req.query.sort !== undefined) {
        const s = String(req.query.sort);
        const key = s.replace(/^-/, "");
        if (key === "created_at") sort = { createdAt: s.startsWith("-") ? -1 : 1 };
        else if (byName[key]) sort = { [`data.${key}`]: s.startsWith("-") ? -1 : 1, _id: 1 };
        else c.add("sort", `Can't sort by "${key}"`);
    }
    c.done();
    const [rows, total] = await Promise.all([
        PlatformRecord.find(q).sort(sort).skip((page - 1) * size).limit(size),
        PlatformRecord.countDocuments(q),
    ]);
    res.json({ items: rows.map((r) => present(col, r)), page, page_size: size, total });
};

const createRecord = async (req, res) => {
    const col = collectionOf(req);
    allow(req, col.access.create);
    if (req.platformRole !== "admin") rateLimit(`app-write:${req.platformApp._id}:${clientIp(req)}`, limits.writesPerMinutePerIp);
    const data = validateRecord(col, req.body);
    if (await PlatformRecord.countDocuments({ appId: req.platformApp._id }) >= limits.recordsPerApp) {
        throw fail(403, "record_limit", `This app has reached its limit of ${limits.recordsPerApp} records.`);
    }
    const r = await PlatformRecord.create({ ...scope(req, col), ownerId: req.appUser?._id || null, data });
    res.status(201).json(present(col, r));
};

const getRecord = async (req, res) => {
    const col = collectionOf(req);
    const r = await PlatformRecord.findOne({ _id: recordId(req), ...scope(req, col), ...allow(req, col.access.read) });
    if (!r) throw fail(404, "not_found", "Record not found.");
    res.json(present(col, r));
};

const updateRecord = async (req, res) => {
    const col = collectionOf(req);
    const changes = validateRecord(col, req.body, { partial: true });
    const r = await PlatformRecord.findOne({ _id: recordId(req), ...scope(req, col), ...allow(req, col.access.update) });
    if (!r) throw fail(404, "not_found", "Record not found.");
    r.data = { ...r.data, ...changes };
    r.markModified("data");
    await r.save();
    res.json(present(col, r));
};

const deleteRecord = async (req, res) => {
    const col = collectionOf(req);
    const r = await PlatformRecord.findOneAndDelete({ _id: recordId(req), ...scope(req, col), ...allow(req, col.access.delete) });
    if (!r) throw fail(404, "not_found", "Record not found.");
    res.status(204).end();
};

// ---------- files ----------
const filesOn = (app) => {
    if (!app.features?.files) throw fail(404, "feature_off", "File uploads are turned off for this app.");
};

const uploadFile = async (req, res) => {
    const app = req.platformApp;
    filesOn(app);
    if (req.platformRole !== "admin" && !req.appUser) throw fail(401, "unauthorized", "Sign in to this app first.");
    if (!req.file) throw fail(422, "validation_error", 'Send one file in the "file" field', { fields: [{ field: "file", message: "A file is required" }] });
    rateLimit(`app-write:${app._id}:${clientIp(req)}`, limits.writesPerMinutePerIp);
    const f = await saveFile(app, req.appUser?._id, req.file.buffer, req.file.originalname);
    res.status(201).json({ ...f, url: `/api/v1/apps/${app.slug}/files/${f.id}` });
};

// GET /files/:fileId - public by its unguessable link (works in <img> without headers)
const getFile = async (req, res) => {
    const app = req.platformApp;
    filesOn(app);
    if (!/^[0-9a-f]{32}$/.test(req.params.fileId)) throw fail(404, "not_found", "File not found.");
    const doc = await findFile(app._id, req.params.fileId);
    if (!doc) throw fail(404, "not_found", "File not found.");
    res.set({
        "Content-Type": doc.contentType,
        "Content-Length": String(doc.length),
        "Cache-Control": "public, max-age=31536000, immutable",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
        "Cross-Origin-Resource-Policy": "cross-origin",
        "Content-Disposition": doc.contentType === "application/pdf" ? `attachment; filename="${doc.metadata.originalName}"` : "inline",
    });
    openFile(doc).on("error", () => res.destroy()).pipe(res);
};

const deleteFile = async (req, res) => {
    const app = req.platformApp;
    filesOn(app);
    if (!/^[0-9a-f]{32}$/.test(req.params.fileId)) throw fail(404, "not_found", "File not found.");
    const doc = await findFile(app._id, req.params.fileId);
    const mine = doc && (req.platformRole === "admin" || (req.appUser && doc.metadata.ownerId === String(req.appUser._id)));
    if (!mine) throw fail(404, "not_found", "File not found.");
    await removeFile(doc);
    res.status(204).end();
};

// ---------- admin (secret key) ----------
const listUsers = async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const size = Math.max(1, Math.min(100, parseInt(req.query.page_size, 10) || 50));
    const q = { appId: req.platformApp._id };
    const [rows, total] = await Promise.all([
        PlatformAppUser.find(q).sort({ createdAt: -1 }).skip((page - 1) * size).limit(size),
        PlatformAppUser.countDocuments(q),
    ]);
    res.json({ items: rows.map(toAppUserDTO), page, page_size: size, total });
};

module.exports = {
    changePassword, createRecord, deleteFile, deleteMe, deleteRecord, docs, forgotPassword, getFile, getRecord, listRecords,
    listUsers, login, me, register, resetPassword, updateMe, updateRecord, uploadFile,
};
