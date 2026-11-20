const mongoose = require("mongoose");

// Runtime state of the CODM event that admins change from the site (the fixed
// settings are CODM_* env vars, see eventConfig()). One document, _id "main".
// cancelledAt is set by "Cancel and refund everyone" and is never cleared by
// the API: once refunds have gone out the event cannot be reopened from here.
const CodmEventStateSchema = new mongoose.Schema(
    {
        _id: { type: String, default: "main" },
        cancelledAt: { type: Date, default: null },
        cancelledBy: { type: String, default: null },
        cancelReason: { type: String, default: null },
    },
    { timestamps: true }
);

module.exports = mongoose.model("CodmEventState", CodmEventStateSchema);
