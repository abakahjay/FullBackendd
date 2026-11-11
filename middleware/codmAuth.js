const jwt = require("jsonwebtoken");
const CodmPlayer = require("../models/CodmPlayer.js");
const { UnauthenticatedError, UnauthorizedError } = require("../errors");

// CODM tournament auth. Bearer header only (no cookies), tokens must carry
// app "codm" and the player's current tokenVersion - same model as CropGuard.
const codmAuth = async (req, res, next) => {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : null;
    if (!token) throw new UnauthenticatedError("Please log in.");

    let decoded;
    try {
        decoded = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
        throw new UnauthenticatedError("Your session has expired. Please log in again.");
    }
    if (decoded.app !== "codm" || typeof decoded.sub !== "string") {
        throw new UnauthenticatedError("Please log in.");
    }

    const player = await CodmPlayer.findById(decoded.sub);
    if (!player || !player.isActive || player.tokenVersion !== decoded.tv) {
        throw new UnauthenticatedError("Your session has expired. Please log in again.");
    }
    req.player = player;
    req.user = { userId: player._id, role: player.role }; // for shared helpers/logging
    next();
};

const requireCodmAdmin = (req, res, next) => {
    if (req.player?.role !== "admin") throw new UnauthorizedError("Admins only.");
    next();
};
requireCodmAdmin.roles = ["admin"]; // shown in the API docs (utils/apiDocs.js)

module.exports = codmAuth;
module.exports.requireCodmAdmin = requireCodmAdmin;
