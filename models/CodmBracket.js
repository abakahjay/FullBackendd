const mongoose = require("mongoose");

// The knockout bracket (single elimination). One document, _id "main".
// Match ids are "r<round>m<index>"; the winner of r0m3 goes to r1m1 slot B
// (next match = r+1, m = floor(index / 2), slot A if index is even else B).
const MatchSchema = new mongoose.Schema(
    {
        id: { type: String, required: true },
        round: { type: Number, required: true },
        index: { type: Number, required: true },
        teamA: { type: mongoose.Schema.Types.ObjectId, ref: "CodmTeam", default: null },
        teamB: { type: mongoose.Schema.Types.ObjectId, ref: "CodmTeam", default: null },
        winner: { type: mongoose.Schema.Types.ObjectId, ref: "CodmTeam", default: null },
        bye: { type: Boolean, default: false }, // only one team: it goes through without playing
        startsAt: { type: Date, default: null },
        note: { type: String, default: null, maxlength: 80 }, // e.g. "Lobby 2 · Firing Range"
        score: { type: String, default: null, maxlength: 20 }, // e.g. "2-1"
    },
    { _id: false }
);

const CodmBracketSchema = new mongoose.Schema(
    {
        _id: { type: String, default: "main" },
        size: { type: Number, required: true }, // 2, 4, 8, 16, 32...
        matches: [MatchSchema],
        generatedAt: { type: Date, default: Date.now },
    },
    { timestamps: true }
);

module.exports = mongoose.model("CodmBracket", CodmBracketSchema);
