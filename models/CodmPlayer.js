const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

// CODM Campus Showdown (UMaT Call of Duty: Mobile tournament) players.
// Fully isolated from the shared `User` model, like SeedBridge/CleanBridge/CropGuard.
// Each player pays the entry fee for themselves; a team is confirmed when every
// one of its members has paid (see controllers/codmTeams.js).
const CodmPlayerSchema = new mongoose.Schema(
    {
        fullName: { type: String, required: true, trim: true, maxlength: 60 },
        email: { type: String, required: true, unique: true, lowercase: true, trim: true, maxlength: 120 },
        // Normalised to +233XXXXXXXXX by the controller (utils/ghana.js).
        phone: { type: String, required: [function () { return this.role !== "admin"; }, "Phone is required"], unique: true, sparse: true, trim: true },
        passwordHash: { type: String, required: true },
        ign: { type: String, required: true, trim: true, maxlength: 20 }, // in-game name
        codmUid: { type: String, required: [function () { return this.role !== "admin"; }, "CODM UID is required"], unique: true, sparse: true, trim: true }, // CODM player UID (digits); organisers may have none
        // Never set from a request body: admins are made with scripts/codmMakeAdmin.js.
        role: { type: String, enum: ["player", "admin"], default: "player" },
        teamId: { type: mongoose.Schema.Types.ObjectId, ref: "CodmTeam", default: null, index: true },
        paid: { type: Boolean, default: false },
        paidAt: { type: Date, default: null },
        paymentReference: { type: String, default: null },
        paymentChannel: { type: String, default: null },
        // Bumped on password change: revokes every token issued before it.
        tokenVersion: { type: Number, default: 0 },
        isActive: { type: Boolean, default: true },
        // When the player accepted the terms/privacy notice and confirmed they are 16+.
        termsAcceptedAt: { type: Date, default: null },
    },
    { timestamps: true }
);

CodmPlayerSchema.methods.setPassword = async function (password) {
    this.passwordHash = await bcrypt.hash(password, 12);
};

CodmPlayerSchema.methods.checkPassword = function (password) {
    return bcrypt.compare(password, this.passwordHash);
};

// No `userId` claim on purpose: the shared middleware/auth.js can never accept
// a CODM token, and middleware/codmAuth.js only accepts tokens with app "codm".
CodmPlayerSchema.methods.createJWT = function () {
    return jwt.sign(
        { sub: String(this._id), role: this.role, tv: this.tokenVersion, app: "codm" },
        process.env.JWT_SECRET,
        { expiresIn: process.env.CODM_JWT_LIFETIME || "7d" }
    );
};

module.exports = mongoose.model("CodmPlayer", CodmPlayerSchema);
