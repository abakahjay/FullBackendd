const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const mongoose = require("mongoose");
const cropguardAuth = require("../middleware/cropguardAuth.js");
const { requireAdmin } = require("../middleware/cropguardAuth.js");
const auth = require("../controllers/cropguardAuth.js");
const predictions = require("../controllers/cropguardPredictions.js");
const system = require("../controllers/cropguardSystem.js");
const admin = require("../controllers/cropguardAdmin.js");
const { registry } = require("../utils/cropguardInference.js");
const { purgeExpired } = require("../utils/cropguardStorage.js");
const { CropGuardError, config } = require("../utils/cropguard.js");

// GhanaCropGuard AI - everything under /api/v1/cropguard.
// Mounted in app.js BEFORE the global body parsers, express-fileupload, xss-clean
// and mongo-sanitize, so this router owns its whole namespace: its own JSON and
// multipart parsing, security headers, strict input checks (only expected types
// reach a query), and the { detail: { code, message } } errors its clients expect.
// It never calls next() past its own 404, so the rest of the server is unaffected.
const router = express.Router();

const maxBytes = Math.round(config.maxUploadMb * 1024 * 1024);

router.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" } }));
router.use((req, res, next) => {
    const len = Number(req.headers["content-length"]);
    if (len > maxBytes + 512 * 1024) {
        return res.status(413).json({ detail: { code: "file_too_large", message: "Request is too large." } });
    }
    next();
});
router.use(express.json({ limit: "64kb" }));

const imageUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 4, fieldSize: 1024, parts: 6 },
}).single("image");
const acceptImage = (req, res, next) => imageUpload(req, res, (err) => next(err));

// ---------- system / content (public) ----------
router.get("/health", system.health);
router.get("/model/info", system.modelInfo);
router.get("/crops", system.crops);
router.get("/policy", system.policy);

// ---------- auth ----------
router.post("/auth/register", auth.register);
router.post("/auth/login", auth.login);
router.post("/auth/forgot-password", auth.forgotPassword);
router.post("/auth/reset-password", auth.resetPassword);
// Google sign-in lives on the shared /api/v1/auth/google?app=cropguard (routes/googleAuth.js).
router.get("/auth/me", cropguardAuth, auth.me);
router.patch("/auth/me", cropguardAuth, auth.updateMe);
router.delete("/auth/me", cropguardAuth, auth.deleteAccount);
router.post("/auth/me/password", cropguardAuth, auth.changePassword);
router.post("/auth/logout-all", cropguardAuth, auth.logoutAll);

// ---------- predictions ----------
// Auth runs before multer so unauthenticated uploads are never buffered.
router.post("/predictions", cropguardAuth, acceptImage, predictions.createPrediction);
router.get("/predictions/history", cropguardAuth, predictions.history);
router.delete("/predictions", cropguardAuth, predictions.deleteAllPredictions);
router.get("/predictions/:predictionId/image", predictions.getImage); // signed link, no header
router.get("/predictions/:predictionId", cropguardAuth, predictions.getPrediction);
router.patch("/predictions/:predictionId", cropguardAuth, predictions.patchPrediction);
router.delete("/predictions/:predictionId", cropguardAuth, predictions.deletePrediction);

// ---------- admin ----------
router.get("/statistics", cropguardAuth, requireAdmin, admin.statistics);
router.get("/admin/users", cropguardAuth, requireAdmin, admin.listUsers);
router.patch("/admin/users/:userId", cropguardAuth, requireAdmin, admin.updateUser);
router.get("/admin/audit", cropguardAuth, requireAdmin, admin.auditLog);
router.get("/admin/models", cropguardAuth, requireAdmin, admin.modelVersions);

router.use((req, res) => {
    res.status(404).json({ detail: { code: "error", message: "Not Found" } });
});

// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
    if (err instanceof CropGuardError) {
        if (err.headers) res.set(err.headers);
        const detail = { code: err.code, message: err.message };
        if (err.fields) detail.fields = err.fields;
        return res.status(err.status).json({ detail });
    }
    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(413).json({ detail: {
                code: "file_too_large",
                message: `Image is larger than ${Math.floor(config.maxUploadMb)} MB. Please use a smaller photo.`,
            } });
        }
        return res.status(400).json({ detail: { code: "bad_upload", message: "Send one image in the \"image\" field." } });
    }
    if (err.type === "entity.too.large") {
        return res.status(413).json({ detail: { code: "file_too_large", message: "Request is too large." } });
    }
    if (err.type === "entity.parse.failed") {
        return res.status(422).json({ detail: { code: "validation_error", message: "The request body is not valid JSON.", fields: [] } });
    }
    console.error("[cropguard] unhandled error", err.stack || err.name); // never the request body or image
    res.status(500).json({ detail: { code: "internal_error", message: "Something went wrong." } });
});

// ---------- startup (once MongoDB is connected) ----------
async function startupTasks() {
    try {
        await registry.ready;
        await admin.registerModelVersion();
        await auth.bootstrapAdmin();
        await purgeExpired();
    } catch (err) {
        console.error(`[cropguard] startup database tasks failed: ${err.name}`);
    }
    setInterval(purgeExpired, 24 * 60 * 60 * 1000).unref();
}
if (mongoose.connection.readyState === 1) startupTasks();
else mongoose.connection.once("open", startupTasks);

module.exports = router;
