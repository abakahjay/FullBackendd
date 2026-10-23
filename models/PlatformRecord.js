const mongoose = require("mongoose");

// One document of a developer-defined collection. `data` only ever holds the
// fields of the collection's schema, already type-checked (utils/platform.js).
const PlatformRecordSchema = new mongoose.Schema(
    {
        appId: { type: mongoose.Schema.Types.ObjectId, ref: "PlatformApp", required: true },
        collectionName: { type: String, required: true },
        ownerId: { type: mongoose.Schema.Types.ObjectId, ref: "PlatformAppUser", default: null },
        data: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    { timestamps: true, minimize: false }
);
PlatformRecordSchema.index({ appId: 1, collectionName: 1, createdAt: -1 });
PlatformRecordSchema.index({ appId: 1, ownerId: 1 });

module.exports = mongoose.model("PlatformRecord", PlatformRecordSchema);
