const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const PlatformApp = require("../models/PlatformApp.js");
const PlatformAppUser = require("../models/PlatformAppUser.js");
const PlatformDeveloper = require("../models/PlatformDeveloper.js");
const { fail, isLocalOrigin, limits, rateLimit, safeEqual, sha256, SLUG_RE } = require("../utils/platform.js");

// Developer platform auth. Three kinds of caller:
// - developers (dashboard): Bearer JWT { sub, app: "platform", type: "access", tv }
// - an app's end users: Bearer JWT { sub, aid, app: "platform-app", type: "access", tv, av }
// - an app's own server: Bearer sk_... secret key = admin of that app only
// Every app request also carries the app's publishable key (X-App-Key) and, from a
// browser, must come from one of the app's registered frontend origins.

const unauth = (message = "Please sign in again.") =>
    fail(401, "unauthorized", message, { headers: { "WWW-Authenticate": "Bearer" } });

const sign = (claims) =>
    jwt.sign({ ...claims, type: "access" }, process.env.JWT_SECRET, { expiresIn: limits.tokenMinutes * 60, algorithm: "HS256" });
const verify = (token) => {
    try {
        return jwt.verify(token, process.env.JWT_SECRET, { algorithms: ["HS256"] });
    } catch (err) {
        throw unauth(err.name === "TokenExpiredError" ? "Your session has expired. Please sign in again." : "Invalid token.");
    }
};
const bearer = (req) => {
    const [scheme, token] = String(req.headers.authorization || "").split(" ");
    return token && scheme.toLowerCase() === "bearer" ? token : null;
};

const createDeveloperToken = (d) => sign({ sub: String(d._id), app: "platform", tv: d.tokenVersion });
const createAppUserToken = (u, app) =>
    sign({ sub: String(u._id), aid: String(app._id), app: "platform-app", tv: u.tokenVersion, av: app.userTokenVersion });

// ---------- developers ----------
const platformDeveloperAuth = async (req, res, next) => {
    const token = bearer(req);
    if (!token) throw unauth("Authentication required.");
    const p = verify(token);
    if (p.app !== "platform" || p.type !== "access" || !mongoose.isValidObjectId(p.sub)) throw unauth("Invalid token.");
    const dev = await PlatformDeveloper.findById(p.sub);
    if (!dev || !dev.isActive || dev.tokenVersion !== p.tv) throw unauth();
    req.developer = dev;
    next();
};

// ---------- apps ----------
/** Resolves :slug, checks the publishable key and the browser origin, then the caller. */
const platformAppContext = async (req, res, next) => {
    const { slug } = req.params;
    if (typeof slug !== "string" || !SLUG_RE.test(slug)) throw fail(404, "not_found", "No such app.");
    const app = await PlatformApp.findOne({ slug });
    if (!app || !app.isActive) throw fail(404, "not_found", "No such app.");
    req.platformApp = app;

    rateLimit(`app:${app._id}`, limits.requestsPerMinutePerApp);

    const token = bearer(req);
    const isSecret = token && token.startsWith("sk_");
    if (isSecret) {
        // Server-side calls: the secret key alone identifies and authorises the app.
        if (!safeEqual(sha256(token), app.secretKeyHash)) throw unauth("Invalid secret key.");
        // A secret key in a web page is a leaked key: refuse it so the mistake shows up at once.
        if (req.headers.origin) {
            throw fail(403, "secret_key_in_browser", "Never use the secret key in a browser. Rotate it in the dashboard and use the publishable key there.");
        }
        req.platformRole = "admin";
        return next();
    }

    const key = req.headers["x-app-key"];
    if (typeof key !== "string" || !safeEqual(key, app.publishableKey)) {
        throw fail(401, "invalid_app_key", "Send this app's publishable key in the X-App-Key header.");
    }
    // Browsers always send Origin on cross-site calls; only the app's own sites may use its key.
    const origin = req.headers.origin;
    if (origin && !(app.frontendOrigins.includes(origin) || (app.allowLocalhost && isLocalOrigin(origin)))) {
        throw fail(403, "origin_not_allowed", `Requests from ${String(origin).slice(0, 100)} are not allowed for this app. Add it to the app's frontend URLs.`);
    }

    req.platformRole = "public";
    if (token) {
        const p = verify(token);
        if (p.app !== "platform-app" || p.type !== "access" || p.aid !== String(app._id) || !mongoose.isValidObjectId(p.sub)) {
            throw unauth("Invalid token.");
        }
        const user = await PlatformAppUser.findOne({ _id: p.sub, appId: app._id });
        if (!user || !user.isActive || user.tokenVersion !== p.tv || app.userTokenVersion !== p.av) throw unauth();
        req.appUser = user;
        req.platformRole = "user";
    }
    next();
};

const requireAppUser = (req, res, next) => {
    if (!req.appUser) throw unauth("Sign in to this app first.");
    next();
};

const requireAppAdmin = (req, res, next) => {
    if (req.platformRole !== "admin") throw fail(403, "forbidden", "This needs the app's secret key (server-side only).");
    next();
};

module.exports = {
    createAppUserToken,
    createDeveloperToken,
    platformAppContext,
    platformDeveloperAuth,
    requireAppAdmin,
    requireAppUser,
};
