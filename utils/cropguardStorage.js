const mongoose = require("mongoose");
const sharp = require("sharp");
const { config } = require("./cropguard.js");
const { roundHalfEven } = require("./cropguardPreprocess.js");

// CropGuard photos live in their own GridFS bucket. Uploads are re-encoded as
// JPEG (sharp drops EXIF/GPS metadata unless asked to keep it) and capped at
// 1024 px on the short side. Storage is optional (CROPGUARD_STORE_IMAGES) and
// unsaved photos expire after CROPGUARD_RETENTION_DAYS.

const BUCKET = "cropguardImages";
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });

async function saveImage(buffer, userId, predictionId) {
    if (!config.storeImages) return null;
    let img = sharp(buffer, { limitInputPixels: config.maxImagePixels }).rotate();
    const meta = await img.metadata();
    // EXIF orientations 5-8 swap width and height once rotated.
    const [width, height] = meta.orientation >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
    const short = Math.min(width, height);
    if (short > 1024) {
        const scale = 1024 / short;
        img = img.resize(Math.max(1, roundHalfEven(width * scale)), Math.max(1, roundHalfEven(height * scale)), { kernel: "cubic" });
    }
    const jpeg = await img.removeAlpha().jpeg({ quality: 85 }).toBuffer();
    return new Promise((resolve, reject) => {
        const stream = bucket().openUploadStream(`${predictionId}.jpg`, {
            contentType: "image/jpeg",
            metadata: { app: "cropguard", userId: String(userId), predictionId: String(predictionId) },
        });
        stream.once("error", reject);
        stream.once("finish", () => resolve(stream.id));
        stream.end(jpeg);
    });
}

function deleteImage(fileId) {
    if (!fileId) return Promise.resolve();
    // Callback form: mongoose 5 bundles the 3.x driver.
    return new Promise((resolve) => bucket().delete(fileId, () => resolve()));
}

function openImage(fileId) {
    return bucket().openDownloadStream(fileId);
}

// Applies the retention policy; never throws.
async function purgeExpired() {
    if (config.retentionDays <= 0) return 0;
    try {
        const CropGuardPrediction = require("../models/CropGuardPrediction.js");
        const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000);
        const rows = await CropGuardPrediction.find(
            { imageFileId: { $ne: null }, createdAt: { $lt: cutoff }, saved: false },
            { imageFileId: 1 }
        );
        for (const r of rows) {
            await deleteImage(r.imageFileId);
            await CropGuardPrediction.updateOne({ _id: r._id }, { $set: { imageFileId: null } });
        }
        if (rows.length) console.log(`[cropguard] retention: removed ${rows.length} expired images`);
        return rows.length;
    } catch (err) {
        console.error(`[cropguard] retention purge failed: ${err.name}`);
        return 0;
    }
}

module.exports = { deleteImage, openImage, purgeExpired, saveImage };
