const path = require("path");
const jwt = require("jsonwebtoken");
const content = require("../data/cropguard/content.json");

// GhanaCropGuard AI (/api/v1/cropguard/*) - shared helpers.
// The web and mobile clients expect errors as { detail: { code, message, fields? } }
// (the contract of the FastAPI backend this replaced), so this namespace has its
// own error type and error handler (routes/cropguard.js) instead of { msg }.

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));
const bool = (v, d) => (v === undefined || v === "" ? d : !["0", "false", "no", "off"].includes(String(v).toLowerCase()));

const config = {
    modelDir: process.env.CROPGUARD_MODEL_DIR
        ? path.resolve(process.env.CROPGUARD_MODEL_DIR)
        : path.join(__dirname, "..", "data", "cropguard", "model"),
    tokenMinutes: num(process.env.CROPGUARD_TOKEN_MINUTES, 60 * 12),
    maxUploadMb: num(process.env.CROPGUARD_MAX_UPLOAD_MB, 8),
    maxImagePixels: num(process.env.CROPGUARD_MAX_IMAGE_PIXELS, 40000000),
    storeImages: bool(process.env.CROPGUARD_STORE_IMAGES, true),
    retentionDays: num(process.env.CROPGUARD_RETENTION_DAYS, 90), // 0 = keep until the user deletes them
    predictionsPerMinute: num(process.env.CROPGUARD_RATE_LIMIT_PREDICTIONS_PER_MINUTE, 20),
    authPerMinute: num(process.env.CROPGUARD_RATE_LIMIT_AUTH_PER_MINUTE, 10),
    minAge: num(process.env.CROPGUARD_MIN_AGE, content.policy.minAge),
    termsVersion: process.env.CROPGUARD_TERMS_VERSION || content.policy.termsVersion,
    lowConfidence: num(process.env.CROPGUARD_LOW_CONFIDENCE_THRESHOLD, 0.6),
    smallMargin: num(process.env.CROPGUARD_SMALL_MARGIN_THRESHOLD, 0.15),
    ortThreads: num(process.env.CROPGUARD_ORT_THREADS, 0),
    // The web app's public origin: allowed as a Google sign-in / reset-link target without an
    // ALLOWED_REDIRECT_DOMAINS edit.
    clientUrl: (process.env.CROPGUARD_CLIENT_URL || "").replace(/\/$/, ""),
    // These emails become administrators when they sign in with Google (Google proves the address).
    adminEmails: (process.env.CROPGUARD_ADMIN_EMAILS || "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean),
    forgotPerWindow: num(process.env.CROPGUARD_RATE_LIMIT_FORGOT_PER_15_MIN, 5),
};

const CLASSES = Object.fromEntries(content.classes.map((c) => [c.key, c]));
const CLASS_KEYS = Object.keys(CLASSES);

// ---------- errors ----------
class CropGuardError extends Error {
    constructor(status, code, message, { fields, headers } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.fields = fields;
        this.headers = headers;
    }
}
const fail = (status, code, message, extra) => new CropGuardError(status, code, message, extra);

// Collects field errors the way the old API did: 422 validation_error, the first
// message as `message` and every one in `fields`.
class Checker {
    constructor() {
        this.fields = [];
    }
    add(field, message) {
        this.fields.push({ field, message });
    }
    done() {
        if (this.fields.length) {
            throw fail(422, "validation_error", this.fields[0].message, { fields: this.fields });
        }
    }
}

const isStr = (v) => typeof v === "string";

const BCRYPT_ROUNDS = 12;

function passwordProblem(pw) {
    if (!isStr(pw)) return "Password is required";
    if (pw.length < 8) return "Password must be at least 8 characters";
    if (Buffer.byteLength(pw, "utf8") > 72) return "Password is too long (max 72 bytes)";
    if (!/\p{L}/u.test(pw) || !/\p{Nd}/u.test(pw)) return "Password must contain letters and numbers";
    return null;
}

// ---------- rate limiting ----------
// In-process sliding window, like the old API. Enough for one Node process;
// several instances would need a shared store.
const hits = new Map();
function rateLimit(key, limit, windowS = 60) {
    if (limit <= 0) return;
    const now = Date.now();
    const q = (hits.get(key) || []).filter((t) => now - t < windowS * 1000);
    if (q.length >= limit) {
        hits.set(key, q);
        const retry = Math.ceil((windowS * 1000 - (now - q[0])) / 1000);
        throw fail(429, "rate_limited", "Too many requests. Please wait and try again.", {
            headers: { "Retry-After": String(Math.max(retry, 1)) },
        });
    }
    q.push(now);
    hits.set(key, q);
}
setInterval(() => {
    const now = Date.now();
    for (const [k, q] of hits) if (!q.length || now - q[q.length - 1] > 15 * 60 * 1000) hits.delete(k);
}, 5 * 60 * 1000).unref();

// Render's proxy appends the real client address as the LAST X-Forwarded-For
// entry; earlier entries come from the client and can be forged.
function clientIp(req) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : req.socket?.remoteAddress || "unknown";
}

// ---------- guidance ----------
function guidanceFor(classKey, lang = "en") {
    const table = content.guidance[lang] || content.guidance.en;
    const g = table[classKey] || content.guidance.en[classKey];
    if (!g) {
        return { summary: "", signs: [], steps: [...content.alwaysSteps], escalate: content.escalate, sources: [] };
    }
    return {
        summary: g.summary,
        signs: [...g.signs],
        steps: [...g.steps, ...content.alwaysSteps],
        escalate: content.escalate,
        sources: g.sources.map((s) => content.sources[s]),
    };
}

// ---------- DTOs (snake_case, `id` not `_id`, never the password hash) ----------
const toUserDTO = (u) => ({
    id: String(u._id),
    email: u.email,
    full_name: u.fullName ?? null,
    role: u.role,
    region: u.region ?? null,
    preferred_language: u.preferredLanguage || "en",
    has_password: Boolean(u.passwordHash),
    google_linked: Boolean(u.googleId),
    created_at: u.createdAt,
});

// Where Google sign-in may send a token and where reset links may point: hosts on the shared
// ALLOWED_REDIRECT_DOMAINS list, plus CROPGUARD_CLIENT_URL's own origin.
function isAllowedRedirect(url) {
    const { isAllowedRedirectUri } = require("./oauthRedirect.js");
    if (isAllowedRedirectUri(url)) return true;
    if (!config.clientUrl) return false;
    try {
        const target = new URL(url);
        const client = new URL(config.clientUrl);
        return target.protocol === client.protocol && target.host === client.host;
    } catch {
        return false;
    }
}

const API_PREFIX = "/api/v1/cropguard";

// Images are served from a short-lived signed link, so <img> tags work without a header.
function imageUrl(p) {
    if (!p.imageFileId) return null;
    const sig = jwt.sign({ pid: String(p._id), type: "image", app: "cropguard" }, process.env.JWT_SECRET, {
        expiresIn: 3600,
        algorithm: "HS256",
    });
    return `${API_PREFIX}/predictions/${p._id}/image?sig=${sig}`;
}

function toPredictionDTO(p, lang = "en") {
    const g = p.classKey
        ? guidanceFor(p.classKey, lang)
        : { summary: "", signs: [], steps: [], escalate: "", sources: [] };
    const top = p.topK || [];
    return {
        id: String(p._id),
        created_at: p.createdAt,
        status: p.status,
        crop: p.crop ?? null,
        predicted: p.status === "success" && top.length ? top[0] : null,
        top_predictions: top,
        explanation: g.summary,
        signs: g.signs,
        next_steps: g.steps,
        escalate: g.escalate,
        sources: g.sources,
        warnings: (p.warnings || []).map((w) => ({ code: w, message: content.warningText[w] || w })),
        model_version: p.modelVersion ?? null,
        processing_ms: p.processingMs ?? null,
        image_url: imageUrl(p),
        saved: Boolean(p.saved),
        note: p.note ?? null,
        disclaimer: content.disclaimer,
    };
}

async function audit(actorId, action, target = null, details = null) {
    const CropGuardAuditEvent = require("../models/CropGuardAuditEvent.js");
    await CropGuardAuditEvent.create({ actorId: actorId || null, action, target, details });
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

module.exports = {
    API_PREFIX,
    BCRYPT_ROUNDS,
    CLASSES,
    CLASS_KEYS,
    Checker,
    CropGuardError,
    audit,
    clientIp,
    config,
    content,
    escapeRegex,
    fail,
    guidanceFor,
    isAllowedRedirect,
    isStr,
    passwordProblem,
    rateLimit,
    toPredictionDTO,
    toUserDTO,
};
