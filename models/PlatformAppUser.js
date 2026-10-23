const mongoose = require("mongoose");

// End users of a developer's app. Scoped by appId: the same email can exist in
// different apps, and a token for one app never works on another.
const PlatformAppUserSchema = new mongoose.Schema(
    {
        appId: { type: mongoose.Schema.Types.ObjectId, ref: "PlatformApp", required: true },
        email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
        passwordHash: { type: String, required: true },
        name: { type: String, default: null, maxlength: 120 },
        isActive: { type: Boolean, default: true },
        tokenVersion: { type: Number, default: 0 },
        resetTokenHash: { type: String, default: null },
        resetTokenExpires: { type: Date, default: null },
    },
    { timestamps: true }
);
PlatformAppUserSchema.index({ appId: 1, email: 1 }, { unique: true });

module.exports = mongoose.model("PlatformAppUser", PlatformAppUserSchema);
