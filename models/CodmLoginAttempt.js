const mongoose = require("mongoose");

// Wrong-password lockout for the CODM login, per browser session and account
// (controllers/codmAuth.js). Kept in MongoDB, not memory, so it holds when the
// backend runs as several instances. Rows delete themselves a day after the
// last attempt (TTL index on expireAt).
const CodmLoginAttemptSchema = new mongoose.Schema({
    key: { type: String, required: true, unique: true }, // sha256(session | identifier)
    fails: { type: Number, default: 0 },
    lockLevel: { type: Number, default: 0 },
    lockedUntil: { type: Date, default: null },
    windowStart: { type: Date, default: null }, // per-account rows: start of the 15-min count
    expireAt: { type: Date, required: true },
});
CodmLoginAttemptSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("CodmLoginAttempt", CodmLoginAttemptSchema);
