const mongoose = require('mongoose');

// One row per device a user has opened Nsoro messages on. `publicKey` is the
// device's ECDH P-256 public key (raw, base64). The private key never leaves the
// device, so the server can store and relay messages but never read them.
const E2eDeviceSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceId: { type: String, required: true, maxlength: 64 },
    publicKey: { type: String, required: true, maxlength: 200 },
    lastSeen: { type: Date, default: Date.now },
}, { timestamps: true });

E2eDeviceSchema.index({ user: 1, deviceId: 1 }, { unique: true });

module.exports = mongoose.model('E2eDevice', E2eDeviceSchema);
