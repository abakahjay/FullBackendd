const mongoose = require("mongoose");

// A CODM tournament team (5v5 Multiplayer). The captain creates it and shares
// the invite code; players join with the code. Size limit: CODM_TEAM_SIZE (5).
const CodmTeamSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true, maxlength: 24 },
        // Lower-cased name: makes "Ghost Squad" and "ghost squad" the same team name.
        nameKey: { type: String, required: true, unique: true },
        tag: { type: String, default: null, trim: true, maxlength: 5 },
        captainId: { type: mongoose.Schema.Types.ObjectId, ref: "CodmPlayer", required: true },
        members: [{ type: mongoose.Schema.Types.ObjectId, ref: "CodmPlayer" }],
        inviteCode: { type: String, required: true, unique: true },
    },
    { timestamps: true }
);

module.exports = mongoose.model("CodmTeam", CodmTeamSchema);
