const mongoose = require("mongoose");

// One encrypted, gzipped SQLite snapshot per JayRouter instance. JayRouter
// encrypts the blob before it leaves the server, so this collection only ever
// holds ciphertext. A document caps at 16 MB; the route rejects anything larger.
const JayRouterBackupSchema = new mongoose.Schema({
    name: { type: String, required: true, unique: true },
    data: { type: Buffer, required: true },
    bytes: { type: Number, required: true },
    updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("JayRouterBackup", JayRouterBackupSchema);
