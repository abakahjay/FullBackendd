const mongoose = require("mongoose");

// Every model bundle this server has loaded (upserted at startup by utils/cropguardInference.js).
const CropGuardModelVersionSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    version: { type: String, required: true },
    arch: { type: String, required: true },
    numClasses: { type: Number, required: true },
    testMetrics: { type: mongoose.Schema.Types.Mixed, default: null },
    // The bundle's meta.json as text: its keys include dots ("model.onnx"), which
    // MongoDB field names can't safely hold.
    metaJson: { type: String, required: true },
    isActive: { type: Boolean, default: false },
    firstLoadedAt: { type: Date, default: Date.now },
    lastLoadedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("CropGuardModelVersion", CropGuardModelVersionSchema);
