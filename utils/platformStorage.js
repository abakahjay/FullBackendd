const crypto = require("crypto");
const mongoose = require("mongoose");
const sharp = require("sharp");
const { fail, limits } = require("./platform.js");

// File uploads for platform apps: GridFS bucket "platformFiles", one namespace per app.
// - The type is decided from the bytes, never from the name or the client's MIME type.
// - Images (JPEG/PNG/WebP/GIF first frame) are re-encoded, which drops EXIF/GPS and any
//   payload hidden in the file; PDFs are kept as they are and always served as downloads.
// - Each file is addressed by a random 128-bit id, so links can't be guessed.

const BUCKET = "platformFiles";
const bucket = () => new mongoose.mongo.GridFSBucket(mongoose.connection.db, { bucketName: BUCKET });
const files = () => mongoose.connection.db.collection(`${BUCKET}.files`);

async function storageUsed(appId) {
    const r = await files().aggregate([{ $match: { "metadata.appId": String(appId) } }, { $group: { _id: null, n: { $sum: "$length" } } }]).toArray();
    return r[0]?.n || 0;
}

async function normalise(buffer) {
    if (buffer.subarray(0, 5).toString("latin1") === "%PDF-") return { bytes: buffer, contentType: "application/pdf", ext: "pdf" };
    let meta;
    try {
        meta = await sharp(buffer, { limitInputPixels: 40e6 }).metadata();
    } catch {
        throw fail(415, "unsupported_file", "Upload a JPEG, PNG, WebP or GIF image, or a PDF.");
    }
    if (!["jpeg", "png", "webp", "gif"].includes(meta.format)) {
        throw fail(415, "unsupported_file", "Upload a JPEG, PNG, WebP or GIF image, or a PDF.");
    }
    const img = sharp(buffer, { limitInputPixels: 40e6 }).rotate().resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true });
    if (meta.format === "png") return { bytes: await img.png().toBuffer(), contentType: "image/png", ext: "png" };
    if (meta.format === "webp") return { bytes: await img.webp({ quality: 85 }).toBuffer(), contentType: "image/webp", ext: "webp" };
    return { bytes: await img.jpeg({ quality: 85 }).toBuffer(), contentType: "image/jpeg", ext: "jpg" };
}

async function saveFile(app, ownerId, buffer, originalName) {
    const used = await storageUsed(app._id);
    if (used + buffer.length > limits.storageMbPerApp * 1024 * 1024) {
        throw fail(413, "storage_full", `This app has used its ${limits.storageMbPerApp} MB of file storage.`);
    }
    const { bytes, contentType, ext } = await normalise(buffer);
    const id = crypto.randomBytes(16).toString("hex");
    const name = String(originalName || "file").replace(/[^\w.-]+/g, "_").slice(0, 80);
    await new Promise((resolve, reject) => {
        const stream = bucket().openUploadStream(`${id}.${ext}`, {
            contentType,
            metadata: { appId: String(app._id), ownerId: ownerId ? String(ownerId) : null, fileId: id, originalName: name },
        });
        stream.once("error", reject);
        stream.once("finish", resolve);
        stream.end(bytes);
    });
    return { id, content_type: contentType, size: bytes.length, name };
}

const findFile = (appId, fileId) => files().findOne({ "metadata.appId": String(appId), "metadata.fileId": fileId });
const openFile = (doc) => bucket().openDownloadStream(doc._id);
const removeFile = (doc) => new Promise((resolve) => bucket().delete(doc._id, () => resolve()));

async function deleteAppFiles(appId) {
    const docs = await files().find({ "metadata.appId": String(appId) }, { projection: { _id: 1 } }).toArray();
    for (const d of docs) await removeFile(d);
}

module.exports = { deleteAppFiles, findFile, openFile, removeFile, saveFile, storageUsed };
