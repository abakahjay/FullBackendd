const mongoose = require("mongoose");

// Security-relevant actions (registration, password change, deletions, admin changes).
const CropGuardAuditEventSchema = new mongoose.Schema({
    actorId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    action: { type: String, required: true, index: true },
    target: { type: String, default: null },
    details: { type: mongoose.Schema.Types.Mixed, default: null },
    createdAt: { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model("CropGuardAuditEvent", CropGuardAuditEventSchema);
