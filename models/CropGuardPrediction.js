const mongoose = require("mongoose");

// One classification request. Failed requests are kept too (status "failed",
// errorCode) so the admin statistics can show why requests fail.
const CropGuardPredictionSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "CropGuardUser", required: true, index: true },
    status: { type: String, enum: ["success", "failed"], default: "success" },
    errorCode: { type: String, default: null },
    crop: { type: String, default: null, index: true },
    classKey: { type: String, default: null, index: true },
    confidence: { type: Number, default: null },
    topK: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    warnings: { type: [String], default: undefined },
    modelVersion: { type: String, default: null, index: true },
    processingMs: { type: Number, default: null },
    // JPEG re-encode (EXIF/GPS stripped) in the `cropguardImages` GridFS bucket.
    imageFileId: { type: mongoose.Schema.Types.ObjectId, default: null },
    imageSha256: { type: String, default: null },
    imageWidth: { type: Number, default: null },
    imageHeight: { type: Number, default: null },
    client: { type: String, enum: ["web", "mobile", "api", null], default: null },
    saved: { type: Boolean, default: false },
    note: { type: String, default: null, maxlength: 1000 },
    createdAt: { type: Date, default: Date.now, index: true },
});

CropGuardPredictionSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model("CropGuardPrediction", CropGuardPredictionSchema);
