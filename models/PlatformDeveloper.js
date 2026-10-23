const mongoose = require("mongoose");

// Developers who register their own apps on the platform (/api/v1/platform/*).
// Separate from every app's users; their tokens carry `app: "platform"`.
const PlatformDeveloperSchema = new mongoose.Schema(
    {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
        passwordHash: { type: String, required: true },
        name: { type: String, default: null, maxlength: 120 },
        isActive: { type: Boolean, default: true },
        tokenVersion: { type: Number, default: 0 },
        termsAcceptedAt: { type: Date, default: null },
        resetTokenHash: { type: String, default: null },
        resetTokenExpires: { type: Date, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model("PlatformDeveloper", PlatformDeveloperSchema);
