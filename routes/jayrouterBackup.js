const crypto = require("crypto");
const express = require("express");
const JayRouterBackup = require("../models/JayRouterBackup.js");

// JayRouter (https://github.com/abakahjay/JayRouter) database backup store,
// under /api/v1/jayrouter/backups/:name. JayRouter runs on Render's free plan
// with no persistent disk, so it GETs its last snapshot here on boot and PUTs a
// fresh one every minute (FREEAPI_DB_BACKUP_URL + FREEAPI_DB_BACKUP_SIGN).
//
// Mounted in app.js before the global body parsers: the upload is raw
// application/octet-stream ciphertext and must reach us byte for byte.
//
// Auth: JayRouter signs every request with an Ed25519 key derived from its own
// ENCRYPTION_KEY ("JayRouter-Ed25519 ts=<ms>,sig=<base64url>" over
// METHOD\npath\nts\nsha256(body)). Only the public key lives here, so there is
// no shared secret to provision. A bearer JAYROUTER_BACKUP_TOKEN is accepted too.
const router = express.Router();

const MAX_BYTES = 15 * 1024 * 1024;
const NAME_RE = /^[a-z0-9-]{1,64}$/;
const MAX_SKEW_MS = 5 * 60 * 1000;
const PUBLIC_KEY_HEX = process.env.JAYROUTER_BACKUP_PUBLIC_KEY
    || "64e76e92758219bfce78af878964992032030075a7efc74fe64ff46d34f4bf20";
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const publicKey = crypto.createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(PUBLIC_KEY_HEX, "hex")]),
    format: "der",
    type: "spki",
});

function tokenMatches(header) {
    const expected = process.env.JAYROUTER_BACKUP_TOKEN;
    const match = /^Bearer (.+)$/.exec(header || "");
    if (!expected || !match) return false;
    const a = crypto.createHash("sha256").update(match[1]).digest();
    const b = crypto.createHash("sha256").update(expected).digest();
    return crypto.timingSafeEqual(a, b);
}

function signatureMatches(req) {
    const match = /^JayRouter-Ed25519 ts=(\d{10,16}),sig=([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || "");
    if (!match) return false;
    const ts = Number(match[1]);
    if (Math.abs(Date.now() - ts) > MAX_SKEW_MS) return false;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const digest = crypto.createHash("sha256").update(body).digest("hex");
    const message = `${req.method}\n${req.baseUrl}${req.path}\n${match[1]}\n${digest}`;
    try {
        return crypto.verify(null, Buffer.from(message), publicKey, Buffer.from(match[2], "base64url"));
    } catch {
        return false;
    }
}

function requireJayRouter(req, res, next) {
    if (tokenMatches(req.headers.authorization) || signatureMatches(req)) return next();
    res.status(401).json({ msg: "Unauthorized" });
}

router.param("name", (req, res, next, name) => {
    if (!NAME_RE.test(name)) return res.status(400).json({ msg: "Invalid backup name" });
    next();
});

router.get("/backups/:name", requireJayRouter, async (req, res) => {
    const backup = await JayRouterBackup.findOne({ name: req.params.name }).lean();
    // 404 tells JayRouter there is nothing to restore yet (first boot).
    if (!backup) return res.status(404).json({ msg: "No backup yet" });
    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", "no-store");
    // .lean() hands back a BSON Binary (bytes in .buffer); a plain Buffer's own
    // .buffer is its whole shared ArrayBuffer, so never read that one.
    const data = Buffer.isBuffer(backup.data) ? backup.data : Buffer.from(backup.data.buffer);
    res.send(data);
});

router.put(
    "/backups/:name",
    // Parse first: the signature covers the body's hash.
    express.raw({ type: "application/octet-stream", limit: MAX_BYTES }),
    requireJayRouter,
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
