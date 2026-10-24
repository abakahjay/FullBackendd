const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const CropGuardPrediction = require("../models/CropGuardPrediction.js");
const { InvalidImageError, ModelUnavailableError, registry } = require("../utils/cropguardInference.js");
const { deleteImage, openImage, saveImage } = require("../utils/cropguardStorage.js");
const {
    CLASSES, Checker, audit, config, content, escapeRegex, fail, isStr, rateLimit, toPredictionDTO,
} = require("../utils/cropguard.js");

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/jpg"];

// JPEG, PNG or WebP by their first bytes, whatever the declared type says.
function looksLikeImage(b) {
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
    if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return true;
    return b.length >= 12 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP";
}

const lang = (req) => req.cropguardUser.preferredLanguage || "en";

async function recordFailure(user, client, code) {
    await CropGuardPrediction.create({
        userId: user._id, status: "failed", errorCode: code, client,
        modelVersion: registry.classifier ? registry.classifier.version : null,
    });
}

// POST /predictions  multipart: image (JPEG/PNG/WebP), client (web|mobile|api)
const createPrediction = async (req, res) => {
    const user = req.cropguardUser;
    rateLimit(`predict:${user._id}`, config.predictionsPerMinute);
    const client = req.body?.client === undefined ? "api" : req.body.client;
    const c = new Checker();
    if (!["web", "mobile", "api"].includes(client)) c.add("client", "client must be web, mobile or api");
    if (!req.file) c.add("image", "Field required");
    c.done();

    const file = req.file;
    if (file.mimetype && !ALLOWED_TYPES.includes(file.mimetype.toLowerCase())) {
        throw fail(415, "unsupported_type", "Please upload a JPEG, PNG or WebP image.");
    }
    const data = file.buffer;
    if (!data.length) throw fail(400, "empty_file", "The uploaded file is empty.");
    if (!looksLikeImage(data)) {
        await recordFailure(user, client, "invalid_image");
        throw fail(400, "invalid_image", "This file is not a supported image.");
    }

    let clf;
    try {
        clf = registry.get();
    } catch (err) {
        if (!(err instanceof ModelUnavailableError)) throw err;
        await recordFailure(user, client, "model_unavailable");
        throw fail(503, "model_unavailable",
            "The AI model is not available right now. No prediction was made. Please try again later.");
    }
    let r;
    try {
        r = await clf.predict(data, {
            maxPixels: config.maxImagePixels, lowConf: config.lowConfidence, smallMargin: config.smallMargin,
        });
    } catch (err) {
        if (err instanceof InvalidImageError) {
            await recordFailure(user, client, "invalid_image");
            throw fail(400, "invalid_image", "We could not read this image. It may be corrupt or not a photo.");
        }
        console.error(`[cropguard] inference failed: ${err.name}`);
        await recordFailure(user, client, "inference_error");
        throw fail(500, "inference_error", "Something went wrong while analysing the image.");
    }
    if (!r.isLeaf) {
        // Not stored: there is nothing to look back at, and the photo may be of anything.
        await recordFailure(user, client, "not_a_leaf");
        throw fail(422, "not_a_leaf",
            "This doesn't look like a leaf. Please upload a close, sharp photo of one cashew, cassava, maize or tomato leaf.");
    }

    const p = new CropGuardPrediction({
        userId: user._id, status: "success", crop: r.crop, classKey: r.classKey, confidence: r.confidence,
        topK: r.topK, warnings: [...r.warnings, "scope"], modelVersion: clf.version,
        processingMs: r.processingMs, imageSha256: crypto.createHash("sha256").update(data).digest("hex"),
        imageWidth: r.imageWidth, imageHeight: r.imageHeight, client,
    });
    try {
        p.imageFileId = await saveImage(data, user._id, p._id);
    } catch (err) {
        p.imageFileId = null; // a storage failure must not lose the prediction
        console.error(`[cropguard] image storage failed: ${err.name}`);
    }
    await p.save();
    res.status(201).json(toPredictionDTO(p, lang(req)));
};

const parseDate = (c, field, v) => {
    if (v === undefined || v === "") return null;
    const d = isStr(v) ? new Date(v) : new Date(NaN);
    if (Number.isNaN(d.getTime())) c.add(field, "Input should be a valid datetime");
    return d;
};

const parseInt0 = (c, field, v, d, min, max) => {
    if (v === undefined || v === "") return d;
    const n = isStr(v) && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) c.add(field, `${field} must be a whole number from ${min} to ${max}`);
    return n;
};

// GET /predictions/history?q=&crop=&class_key=&saved=&date_from=&date_to=&page=&page_size=
const history = async (req, res) => {
    const qs = req.query;
    const c = new Checker();
    const str = (field, max) => {
        const v = qs[field];
        if (v === undefined || v === "") return null;
        if (!isStr(v) || v.length > max) c.add(field, `${field} must be text of at most ${max} characters`);
        return v;
    };
    const q = str("q", 60);
    const crop = str("crop", 16);
    if (crop && !content.crops.includes(crop)) c.add("crop", "Unknown crop");
    const classKey = str("class_key", 64);
    let saved = null;
    if (qs.saved !== undefined && qs.saved !== "") {
        if (["true", "1"].includes(qs.saved)) saved = true;
        else if (["false", "0"].includes(qs.saved)) saved = false;
        else c.add("saved", "saved must be true or false");
    }
    const dateFrom = parseDate(c, "date_from", qs.date_from);
    const dateTo = parseDate(c, "date_to", qs.date_to);
    const page = parseInt0(c, "page", qs.page, 1, 1, 1e6);
    const pageSize = parseInt0(c, "page_size", qs.page_size, 20, 1, 100);
    c.done();

    const filter = { userId: req.cropguardUser._id, status: "success" };
    if (crop) filter.crop = crop;
    if (classKey) filter.classKey = classKey;
    if (saved !== null) filter.saved = saved;
    if (dateFrom || dateTo) {
        filter.createdAt = {};
        if (dateFrom) filter.createdAt.$gte = dateFrom;
        if (dateTo) filter.createdAt.$lte = dateTo;
    }
    if (q) {
        const ql = q.toLowerCase().trim();
        const keys = Object.values(CLASSES)
            .filter((ci) => ci.display_name.toLowerCase().includes(ql) || ci.crop.includes(ql) || ci.key.includes(ql))
            .map((ci) => ci.key);
        const or = [{ note: { $regex: escapeRegex(ql), $options: "i" } }];
        if (keys.length) or.unshift({ classKey: { $in: keys } });
        filter.$or = or;
    }
    const [total, rows] = await Promise.all([
        CropGuardPrediction.countDocuments(filter),
        CropGuardPrediction.find(filter).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize),
    ]);
    res.json({ items: rows.map((r) => toPredictionDTO(r, lang(req))), total, page, page_size: pageSize });
};

// 404 (not 403) for other users' records so ids cannot be probed.
async function own(req) {
    const id = req.params.predictionId;
    const p = mongoose.isValidObjectId(id) ? await CropGuardPrediction.findById(id) : null;
    if (!p || String(p.userId) !== String(req.cropguardUser._id)) throw fail(404, "not_found", "Prediction not found.");
    return p;
}

// GET /predictions/:predictionId
const getPrediction = async (req, res) => {
    res.json(toPredictionDTO(await own(req), lang(req)));
};

// PATCH /predictions/:predictionId  { saved?, note? }
const patchPrediction = async (req, res) => {
    const b = req.body || {};
    const c = new Checker();
    if (b.saved !== undefined && b.saved !== null && typeof b.saved !== "boolean") c.add("saved", "saved must be true or false");
    if (b.note !== undefined && b.note !== null && (!isStr(b.note) || b.note.length > 1000)) {
        c.add("note", "Note must be text of at most 1000 characters");
    }
    c.done();
    const p = await own(req);
    if (b.saved !== undefined && b.saved !== null) p.saved = b.saved;
    if (b.note !== undefined) p.note = b.note;
    await p.save();
    res.json(toPredictionDTO(p, lang(req)));
};

// DELETE /predictions/:predictionId  -> 204
const deletePrediction = async (req, res) => {
    const p = await own(req);
    await deleteImage(p.imageFileId);
    await CropGuardPrediction.deleteOne({ _id: p._id });
    await audit(req.cropguardUser._id, "prediction.delete", String(p._id));
    res.status(204).end();
};

// DELETE /predictions  -> 204. The user's whole history and images (data deletion control).
const deleteAllPredictions = async (req, res) => {
    const userId = req.cropguardUser._id;
    const rows = await CropGuardPrediction.find({ userId }, { imageFileId: 1 });
    for (const p of rows) await deleteImage(p.imageFileId);
    await CropGuardPrediction.deleteMany({ userId });
    await audit(userId, "prediction.delete_all", String(userId), { count: rows.length });
    res.status(204).end();
};

// GET /predictions/:predictionId/image?sig=  (signed link from image_url, no auth header)
const getImage = async (req, res) => {
    const id = req.params.predictionId;
    let payload;
    try {
        payload = jwt.verify(String(req.query.sig || ""), process.env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch {
        throw fail(403, "forbidden", "Link expired.");
    }
    if (payload.type !== "image" || payload.app !== "cropguard" || payload.pid !== id) {
        throw fail(403, "forbidden", "Invalid link.");
    }
    const p = mongoose.isValidObjectId(id) ? await CropGuardPrediction.findById(id, { imageFileId: 1 }) : null;
    if (!p || !p.imageFileId) throw fail(404, "not_found", "Image not found.");
    const stream = openImage(p.imageFileId);
    stream.once("error", () => {
        if (!res.headersSent) res.status(404).json({ detail: { code: "not_found", message: "Image not found." } });
        else res.end();
    });
    stream.once("file", () => {
        res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=3600" });
    });
    stream.pipe(res);
};

module.exports = {
    createPrediction, deleteAllPredictions, deletePrediction, getImage, getPrediction, history, patchPrediction,
};
