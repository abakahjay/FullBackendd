const mongoose = require('mongoose');

// One Nsoro Android app install that can be woken with Firebase Cloud Messaging
// (utils/fcm.js), and the account signed in on it.
const fcmTokenSchema = new mongoose.Schema(
    {
        userId: { type: mongoose.Types.ObjectId, required: true, index: true },
        token: { type: String, required: true, unique: true },
        versionCode: Number,
        lastSuccessAt: Date,
    },
    { timestamps: true }
);

module.exports = mongoose.model('FcmToken', fcmTokenSchema);
