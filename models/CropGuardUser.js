const mongoose = require("mongoose");
const { content } = require("../utils/cropguard.js");

// GhanaCropGuard AI accounts. A separate collection from the shared `User`
// (and from SeedBridge/CleanBridge users): CropGuard tokens carry
// `app: "cropguard"` and resolve only against this model.
const CropGuardUserSchema = new mongoose.Schema(
    {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 254 },
        // Optional only for accounts created with Google sign-in (they can add one through "Forgot password").
        passwordHash: { type: String, required() { return !this.googleId; } },
        googleId: { type: String, unique: true, sparse: true },
        fullName: { type: String, default: null, maxlength: 120 },
        role: { type: String, enum: ["user", "admin"], default: "user" },
        region: { type: String, enum: [...content.regions, null], default: null },
        preferredLanguage: { type: String, default: "en" },
        isActive: { type: Boolean, default: true },
        // Bumped to revoke every token issued so far (password change, sign out everywhere, deactivation).
        tokenVersion: { type: Number, default: 0 },
        ageConfirmedAt: { type: Date, default: null },
        termsAcceptedAt: { type: Date, default: null },
        termsVersion: { type: String, default: null },
        // Password reset: only the SHA-256 of the emailed token is stored; single use, 30 minutes.
        resetTokenHash: { type: String, default: null },
        resetTokenExpires: { type: Date, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model("CropGuardUser", CropGuardUserSchema);
