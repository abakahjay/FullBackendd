const mongoose = require("mongoose");

// An app a developer registered: where its frontends live and which collections its
// API serves. The spec is validated by utils/platform.js validateAppSpec before saving.
const FieldSchema = new mongoose.Schema(
    {
        name: String,
        type: String,
        required: Boolean,
        maxLength: Number,
        maxItems: Number,
        min: Number,
        max: Number,
        values: [String],
    },
    { _id: false }
);

const CollectionSchema = new mongoose.Schema(
    {
        name: String,
        fields: [FieldSchema],
        access: { read: String, create: String, update: String, delete: String },
    },
    { _id: false }
);

const PlatformAppSchema = new mongoose.Schema(
    {
        developerId: { type: mongoose.Schema.Types.ObjectId, ref: "PlatformDeveloper", required: true, index: true },
        name: { type: String, required: true, maxlength: 60 },
        slug: { type: String, required: true, unique: true },
        description: { type: String, default: null },
        frontendOrigins: { type: [String], default: [] },
        allowLocalhost: { type: Boolean, default: true },
        features: { auth: { type: Boolean, default: true }, files: { type: Boolean, default: false } },
        collections: { type: [CollectionSchema], default: [] },
        // Public: identifies the app from browsers and phones.
        publishableKey: { type: String, required: true, unique: true },
        // Only the SHA-256 is stored; the key is shown once when created or rotated.
        secretKeyHash: { type: String, required: true },
        secretKeyHint: { type: String, required: true },
        // Bumped to sign out every end user of this app.
        userTokenVersion: { type: Number, default: 0 },
        isActive: { type: Boolean, default: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model("PlatformApp", PlatformAppSchema);
