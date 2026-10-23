const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const CropGuardUser = require("../models/CropGuardUser.js");
const { config, fail } = require("../utils/cropguard.js");

// GhanaCropGuard auth. Bearer header only (the web and mobile apps send it on
// every request; no cookies, so no CSRF). Tokens must carry
// `app: "cropguard"`, resolve against CropGuardUser and match its tokenVersion,
// so another app's token never works here and a CropGuard token has no
// `userId` claim for the shared middleware/auth.js to accept.

const unauth = (message = "Please sign in again.") =>
    fail(401, "unauthorized", message, { headers: { "WWW-Authenticate": "Bearer" } });

function createToken(user) {
    const expiresIn = config.tokenMinutes * 60;
    const token = jwt.sign(
        { sub: String(user._id), role: user.role, tv: user.tokenVersion, type: "access", app: "cropguard" },
        process.env.JWT_SECRET,
        { expiresIn, algorithm: "HS256" }
    );
    return { token, expiresIn };
}

const cropguardAuth = async (req, res, next) => {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (!token || scheme.toLowerCase() !== "bearer") throw unauth("Authentication required.");

    let payload;
    try {
        payload = jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch (err) {
        if (err.name === "TokenExpiredError") throw unauth("Your session has expired. Please sign in again.");
        throw unauth("Invalid token.");
    }
    if (payload.app !== "cropguard" || payload.type !== "access" || !mongoose.isValidObjectId(payload.sub)) {
        throw unauth("Invalid token.");
    }

    const user = await CropGuardUser.findById(payload.sub);
    if (!user || !user.isActive || payload.tv !== user.tokenVersion) throw unauth();
    req.cropguardUser = user;
    next();
};

const requireAdmin = (req, res, next) => {
    if (req.cropguardUser?.role !== "admin") throw fail(403, "forbidden", "Administrator access required.");
    next();
};
requireAdmin.roles = ["admin"]; // shown in the API docs (utils/apiDocs.js)

module.exports = cropguardAuth;
module.exports.requireAdmin = requireAdmin;
module.exports.createToken = createToken;
