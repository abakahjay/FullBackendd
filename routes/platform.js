const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const PlatformApp = require("../models/PlatformApp.js");
const devs = require("../controllers/platformDevelopers.js");
const apps = require("../controllers/platformApps.js");
const rt = require("../controllers/platformRuntime.js");
const {
    platformAppContext, platformDeveloperAuth, requireAppAdmin, requireAppUser,
} = require("../middleware/platformAuth.js");
const { PlatformError, SLUG_RE, fail, limits } = require("../utils/platform.js");

// Developer platform. Two routers, both mounted in app.js BEFORE the global body
// parsers and sanitizers (like GhanaCropGuard), because they parse and type-check
// their own input and answer { detail: { code, message, fields? } }:
//   /api/v1/platform/*      developers manage their apps (dashboard at /developers)
//   /api/v1/apps/<slug>/*   the API generated for each app

const secure = helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } });
const json = express.json({ limit: "64kb" });

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
    const send = (status, code, message, fields) => res.status(status).json({ detail: { code, message, ...(fields ? { fields } : {}) } });
    if (err instanceof PlatformError) {
        if (err.headers) res.set(err.headers);
        return send(err.status, err.code, err.message, err.fields);
    }
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") return send(413, "file_too_large", `Files may be at most ${limits.fileMb} MB.`);
        return send(400, "bad_upload", 'Send one file in the "file" field.');
    }
    if (err.type === "entity.too.large") return send(413, "too_large", "Request is too large.");
    if (err.type === "entity.parse.failed") return send(422, "validation_error", "The request body is not valid JSON.", []);
    console.error("[platform] unhandled error", err.stack || err.name); // never the body
    return send(500, "internal_error", "Something went wrong.");
}
const notFound = (req, res) => res.status(404).json({ detail: { code: "not_found", message: "Not Found" } });

// ---------- /api/v1/platform ----------
const platform = express.Router();
platform.use(secure, json);
platform.post("/auth/register", devs.register);
platform.post("/auth/login", devs.login);
platform.post("/auth/forgot-password", devs.forgotPassword);
platform.post("/auth/reset-password", devs.resetPassword);
platform.get("/auth/me", platformDeveloperAuth, devs.me);
platform.patch("/auth/me", platformDeveloperAuth, devs.updateMe);
platform.post("/auth/me/password", platformDeveloperAuth, devs.changePassword);
platform.post("/auth/logout-all", platformDeveloperAuth, devs.logoutAll);
platform.delete("/auth/me", platformDeveloperAuth, devs.deleteAccount);

platform.get("/apps", platformDeveloperAuth, apps.listApps);
platform.post("/apps", platformDeveloperAuth, apps.createApp);
platform.get("/apps/:appId", platformDeveloperAuth, apps.getApp);
platform.patch("/apps/:appId", platformDeveloperAuth, apps.updateApp);
platform.delete("/apps/:appId", platformDeveloperAuth, apps.deleteApp);
platform.get("/apps/:appId/stats", platformDeveloperAuth, apps.stats);
platform.post("/apps/:appId/suggest", platformDeveloperAuth, apps.suggestApi);
platform.post("/apps/:appId/collections", platformDeveloperAuth, apps.addCollection);
platform.delete("/apps/:appId/collections/:name", platformDeveloperAuth, apps.removeCollection);
platform.post("/apps/:appId/rotate-secret", platformDeveloperAuth, apps.rotateSecret);
platform.post("/apps/:appId/rotate-publishable-key", platformDeveloperAuth, apps.rotatePublishable);
platform.post("/apps/:appId/sign-out-users", platformDeveloperAuth, apps.signOutUsers);
platform.use(notFound);
platform.use(errorHandler);

// ---------- /api/v1/apps/:slug ----------
const runtime = express.Router();
runtime.use(secure);

// Docs and file links need no key: docs hold no data, file ids are unguessable.
const appBySlug = async (req, res, next) => {
    const { slug } = req.params;
    const app = SLUG_RE.test(String(slug)) ? await PlatformApp.findOne({ slug, isActive: true }) : null;
    if (!app) throw fail(404, "not_found", "No such app.");
    req.platformApp = app;
    next();
};
runtime.get("/:slug/docs", appBySlug, rt.docs);
runtime.get("/:slug/files/:fileId", appBySlug, rt.getFile);

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: limits.fileMb * 1024 * 1024, files: 1, fields: 2, parts: 3 },
}).single("file");
// The key and origin are checked before the body is read, so refused uploads are never buffered.
runtime.use("/:slug", platformAppContext);
runtime.post("/:slug/files", (req, res, next) => upload(req, res, next), rt.uploadFile);
runtime.use(json);

runtime.post("/:slug/auth/register", rt.register);
runtime.post("/:slug/auth/login", rt.login);
runtime.post("/:slug/auth/forgot-password", rt.forgotPassword);
runtime.post("/:slug/auth/reset-password", rt.resetPassword);
runtime.get("/:slug/auth/me", requireAppUser, rt.me);
runtime.patch("/:slug/auth/me", requireAppUser, rt.updateMe);
runtime.post("/:slug/auth/me/password", requireAppUser, rt.changePassword);
runtime.delete("/:slug/auth/me", requireAppUser, rt.deleteMe);

runtime.get("/:slug/data/:collection", rt.listRecords);
runtime.post("/:slug/data/:collection", rt.createRecord);
runtime.get("/:slug/data/:collection/:id", rt.getRecord);
runtime.patch("/:slug/data/:collection/:id", rt.updateRecord);
runtime.delete("/:slug/data/:collection/:id", rt.deleteRecord);

runtime.delete("/:slug/files/:fileId", rt.deleteFile);
runtime.get("/:slug/admin/users", requireAppAdmin, rt.listUsers);
runtime.use(notFound);
runtime.use(errorHandler);

module.exports = { platform, runtime };
