const crypto = require("crypto");
const express = require("express");
const JayRouterBackup = require("../models/JayRouterBackup.js");

// JayRouter (https://github.com/abakahjay/JayRouter) database backup store,
// under /api/v1/jayrouter/backups/:name. JayRouter runs on Render's free plan
// with no persistent disk, so it GETs its last snapshot here on boot and PUTs a
// fresh one every few minutes (FREEAPI_DB_BACKUP_URL / FREEAPI_DB_BACKUP_TOKEN).
//
// Mounted in app.js before the global body parsers: the upload is raw
// application/octet-stream ciphertext and must reach us byte for byte.
// Auth is a single shared bearer token, JAYROUTER_BACKUP_TOKEN; without it the
// whole namespace answers 503 rather than running open.
const router = express.Router();

const MAX_BYTES = 15 * 1024 * 1024;
const NAME_RE = /^[a-z0-9-]{1,64}$/;

function tokenMatches(header) {
    const expected = process.env.JAYROUTER_BACKUP_TOKEN || "";
    const match = /^Bearer (.+)$/.exec(header || "");
    if (!match) return false;
    const a = crypto.createHash("sha256").update(match[1]).digest();
    const b = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
    if (!process.env.JAYROUTER_BACKUP_TOKEN) {
        return res.status(503).json({ msg: "JayRouter backups are not configured" });
    }
    if (!tokenMatches(req.headers.authorization)) {
        return res.status(401).json({ msg: "Unauthorized" });
    }
    next();
});

router.param("name", (req, res, next, name) => {
    if (!NAME_RE.test(name)) return res.status(400).json({ msg: "Invalid backup name" });
    next();
});

router.get("/backups/:name", async (req, res) => {
    const backup = await JayRouterBackup.findOne({ name: req.params.name }).lean();
    // 404 tells JayRouter there is nothing to restore yet (first boot).
    if (!backup) return res.status(404).json({ msg: "No backup yet" });
    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", "no-store");
    res.send(Buffer.from(backup.data.buffer || backup.data));
});

router.put(
    "/backups/:name",
    express.raw({ type: "application/octet-stream", limit: MAX_BYTES }),
    async (req, res) => {
        if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
            return res.status(400).json({ msg: "Expected an application/octet-stream body" });
        }
        await JayRouterBackup.findOneAndUpdate(
            { name: req.params.name },
            { data: req.body, bytes: req.body.length, updatedAt: new Date() },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        res.status(204).end();
    }
);

router.use((err, req, res, next) => {
    if (err.type === "entity.too.large") return res.status(413).json({ msg: "Backup is too large" });
    next(err);
});

module.exports = router;
