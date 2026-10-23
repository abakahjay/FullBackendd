const crypto = require("crypto");
const validator = require("validator");

// Developer platform (/api/v1/platform/* and /api/v1/apps/<slug>/*) - shared helpers.
//
// Developers describe their app (frontend URLs, collections with typed fields and
// access rules); routes/platformApps.js then serves a ready API for it. Nothing a
// developer writes is ever executed: the spec is data, validated here, and every
// stored value is checked against it. Errors use { detail: { code, message, fields? } }
// like GhanaCropGuard.

const num = (v, d) => (v === undefined || v === "" || Number.isNaN(Number(v)) ? d : Number(v));

const limits = {
    appsPerDeveloper: num(process.env.PLATFORM_MAX_APPS_PER_DEVELOPER, 5),
    collectionsPerApp: num(process.env.PLATFORM_MAX_COLLECTIONS, 20),
    fieldsPerCollection: 40,
    frontendUrls: 10,
    recordsPerApp: num(process.env.PLATFORM_MAX_RECORDS_PER_APP, 10000),
    usersPerApp: num(process.env.PLATFORM_MAX_USERS_PER_APP, 10000),
    recordBytes: 16 * 1024,
    fileMb: num(process.env.PLATFORM_MAX_FILE_MB, 5),
    storageMbPerApp: num(process.env.PLATFORM_MAX_STORAGE_MB_PER_APP, 100),
    requestsPerMinutePerApp: num(process.env.PLATFORM_REQUESTS_PER_MINUTE_PER_APP, 600),
    writesPerMinutePerIp: num(process.env.PLATFORM_WRITES_PER_MINUTE_PER_IP, 60),
    authPerMinutePerIp: num(process.env.PLATFORM_AUTH_PER_MINUTE_PER_IP, 10),
    tokenMinutes: num(process.env.PLATFORM_TOKEN_MINUTES, 60 * 24 * 7),
};

// ---------- errors ----------
class PlatformError extends Error {
    constructor(status, code, message, { fields, headers } = {}) {
        super(message);
        this.status = status;
        this.code = code;
        this.fields = fields;
        this.headers = headers;
    }
}
const fail = (status, code, message, extra) => new PlatformError(status, code, message, extra);

class Checker {
    constructor() {
        this.fields = [];
    }
    add(field, message) {
        this.fields.push({ field, message });
        return this;
    }
    get ok() {
        return this.fields.length === 0;
    }
    done() {
        if (this.fields.length) throw fail(422, "validation_error", this.fields[0].message, { fields: this.fields });
    }
}

const isStr = (v) => typeof v === "string";
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function passwordProblem(pw) {
    if (!isStr(pw)) return "Password is required";
    if (pw.length < 8) return "Password must be at least 8 characters";
    if (Buffer.byteLength(pw, "utf8") > 72) return "Password is too long (max 72 bytes)";
    if (!/\p{L}/u.test(pw) || !/\p{Nd}/u.test(pw)) return "Password must contain letters and numbers";
    return null;
}

// ---------- rate limiting (in-process sliding window) ----------
const hits = new Map();
function rateLimit(key, limit, windowS = 60) {
    if (limit <= 0) return;
    const now = Date.now();
    const q = (hits.get(key) || []).filter((t) => now - t < windowS * 1000);
    if (q.length >= limit) {
        hits.set(key, q);
        const retry = Math.max(1, Math.ceil((windowS * 1000 - (now - q[0])) / 1000));
        throw fail(429, "rate_limited", "Too many requests. Please wait and try again.", { headers: { "Retry-After": String(retry) } });
    }
    q.push(now);
    hits.set(key, q);
}
setInterval(() => {
    const now = Date.now();
    for (const [k, q] of hits) if (!q.length || now - q[q.length - 1] > 60 * 60 * 1000) hits.delete(k);
}, 5 * 60 * 1000).unref();

// Render appends the real client as the LAST X-Forwarded-For entry; earlier ones can be forged.
function clientIp(req) {
    const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
    return xff.length ? xff[xff.length - 1] : req.socket?.remoteAddress || "unknown";
}

// ---------- keys ----------
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const newPublishableKey = () => `pk_${crypto.randomBytes(18).toString("hex")}`;
const newSecretKey = () => `sk_${crypto.randomBytes(32).toString("hex")}`;
const safeEqual = (a, b) => {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// ---------- app spec ----------
const SLUG_RE = /^[a-z][a-z0-9-]{2,39}$/;
const RESERVED_SLUGS = new Set([
    "admin", "api", "app", "apps", "platform", "auth", "docs", "www", "static", "public", "system",
    "cropguard", "cleanbridge", "seedbridge", "ghgpt", "nsoro", "portfolio", "fullbackendd",
]);
const COLLECTION_RE = /^[a-z][a-z0-9_]{0,39}$/;
const FIELD_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,39}$/;
const RESERVED_FIELDS = new Set(["id", "_id", "owner", "owner_id", "created_at", "updated_at", "app", "collection"]);
const FIELD_TYPES = ["string", "text", "number", "integer", "boolean", "date", "email", "url", "enum", "string_list", "file"];
const READ_RULES = ["public", "signed_in", "owner", "admin"];
const CREATE_RULES = ["public", "signed_in", "admin"];
const CHANGE_RULES = ["owner", "admin"];

const slugify = (name) => String(name).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Exact origin of an http(s) URL, or null. */
function originOf(url) {
    try {
        const u = new URL(url);
        if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
        return u.origin;
    } catch {
        return null;
    }
}
const isLocalOrigin = (origin) => {
    try {
        return ["localhost", "127.0.0.1", "[::1]"].includes(new URL(origin).hostname);
    } catch {
        return false;
    }
};

/**
 * Validates and normalises a developer's app description. Throws 422 with field paths.
 * `partial` allows PATCH bodies (only the keys present are checked).
 */
function validateAppSpec(body, { partial = false } = {}) {
    const b = isObj(body) ? body : {};
    const c = new Checker();
    const out = {};

    if (!partial || b.name !== undefined) {
        if (!isStr(b.name) || !b.name.trim() || b.name.length > 60) c.add("name", "App name is required (at most 60 characters)");
        else out.name = b.name.trim();
    }
    if (!partial && b.slug !== undefined) {
        if (!isStr(b.slug) || !SLUG_RE.test(b.slug)) c.add("slug", "Slug: 3-40 lowercase letters, digits or dashes, starting with a letter");
        else if (RESERVED_SLUGS.has(b.slug)) c.add("slug", "That slug is reserved");
        else out.slug = b.slug;
    }
    if (b.description !== undefined) {
        if (b.description !== null && (!isStr(b.description) || b.description.length > 500)) c.add("description", "Description: at most 500 characters");
        else out.description = b.description || null;
    }
    if (!partial || b.frontend_urls !== undefined) {
        const urls = b.frontend_urls;
        if (!Array.isArray(urls) || urls.length > limits.frontendUrls) {
            c.add("frontend_urls", `List your frontend URLs (at most ${limits.frontendUrls})`);
        } else {
            const origins = [];
            urls.forEach((u, i) => {
                const o = isStr(u) ? originOf(u.trim()) : null;
                if (!o) c.add(`frontend_urls[${i}]`, "Must be an http(s) URL like https://myapp.onrender.com");
                else if (!o.startsWith("https://") && !isLocalOrigin(o)) c.add(`frontend_urls[${i}]`, "Use https (http is only allowed for localhost)");
                else if (!origins.includes(o)) origins.push(o);
            });
            out.frontendOrigins = origins;
        }
    }
    if (b.allow_localhost !== undefined) {
        if (typeof b.allow_localhost !== "boolean") c.add("allow_localhost", "Must be true or false");
        else out.allowLocalhost = b.allow_localhost;
    }
    if (b.features !== undefined) {
        const f = b.features;
        if (!isObj(f)) c.add("features", "features must be an object");
        else {
            out.features = {};
            for (const k of ["auth", "files"]) {
                if (f[k] !== undefined && typeof f[k] !== "boolean") c.add(`features.${k}`, "Must be true or false");
                else if (f[k] !== undefined) out.features[k] = f[k];
            }
            for (const k of Object.keys(f)) if (!["auth", "files"].includes(k)) c.add(`features.${k}`, "Unknown feature");
        }
    }
    if (!partial || b.collections !== undefined) {
        const cols = b.collections ?? [];
        if (!Array.isArray(cols) || cols.length > limits.collectionsPerApp) {
            c.add("collections", `collections must be a list (at most ${limits.collectionsPerApp})`);
        } else {
            const seen = new Set();
            out.collections = cols.map((col, i) => validateCollection(col, `collections[${i}]`, c, seen)).filter(Boolean);
        }
    }
    c.done();
    return out;
}

function validateCollection(col, path, c, seen) {
    if (!isObj(col)) {
        c.add(path, "Each collection must be an object");
        return null;
    }
    const name = col.name;
    if (!isStr(name) || !COLLECTION_RE.test(name)) {
        c.add(`${path}.name`, "Collection name: lowercase letters, digits and _, starting with a letter (max 40)");
        return null;
    }
    if (seen.has(name)) c.add(`${path}.name`, `Duplicate collection "${name}"`);
    seen.add(name);

    const access = isObj(col.access) ? col.access : {};
    const rules = {
        read: access.read ?? "public",
        create: access.create ?? "signed_in",
        update: access.update ?? "owner",
        delete: access.delete ?? "owner",
    };
    if (!READ_RULES.includes(rules.read)) c.add(`${path}.access.read`, `read must be one of ${READ_RULES.join(", ")}`);
    if (!CREATE_RULES.includes(rules.create)) c.add(`${path}.access.create`, `create must be one of ${CREATE_RULES.join(", ")}`);
    for (const k of ["update", "delete"]) {
        if (!CHANGE_RULES.includes(rules[k])) c.add(`${path}.access.${k}`, `${k} must be one of ${CHANGE_RULES.join(", ")}`);
    }

    const fields = col.fields;
    if (!Array.isArray(fields) || !fields.length || fields.length > limits.fieldsPerCollection) {
        c.add(`${path}.fields`, `Give 1-${limits.fieldsPerCollection} fields`);
        return null;
    }
    const names = new Set();
    const outFields = fields.map((f, j) => {
        const fp = `${path}.fields[${j}]`;
        if (!isObj(f)) return c.add(fp, "Each field must be an object") && null;
        if (!isStr(f.name) || !FIELD_RE.test(f.name)) return c.add(`${fp}.name`, "Field name: letters, digits and _, starting with a letter (max 40)") && null;
        if (RESERVED_FIELDS.has(f.name.toLowerCase())) return c.add(`${fp}.name`, `"${f.name}" is reserved`) && null;
        if (names.has(f.name)) c.add(`${fp}.name`, `Duplicate field "${f.name}"`);
        names.add(f.name);
        if (!FIELD_TYPES.includes(f.type)) return c.add(`${fp}.type`, `type must be one of ${FIELD_TYPES.join(", ")}`) && null;
        const field = { name: f.name, type: f.type, required: f.required === true };
        if (f.required !== undefined && typeof f.required !== "boolean") c.add(`${fp}.required`, "Must be true or false");
        if (["string", "text", "string_list"].includes(f.type)) {
            const cap = f.type === "text" ? 20000 : 2000;
            const max = f.max_length ?? (f.type === "text" ? 5000 : 200);
            if (!Number.isInteger(max) || max < 1 || max > cap) c.add(`${fp}.max_length`, `max_length must be 1-${cap}`);
            field.maxLength = max;
        }
        if (f.type === "string_list") {
            const maxItems = f.max_items ?? 20;
            if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 100) c.add(`${fp}.max_items`, "max_items must be 1-100");
            field.maxItems = maxItems;
        }
        if (["number", "integer"].includes(f.type)) {
            for (const k of ["min", "max"]) {
                if (f[k] !== undefined && (typeof f[k] !== "number" || !Number.isFinite(f[k]))) c.add(`${fp}.${k}`, `${k} must be a number`);
                else if (f[k] !== undefined) field[k] = f[k];
            }
        }
        if (f.type === "enum") {
            const vals = f.values;
            if (!Array.isArray(vals) || !vals.length || vals.length > 50 || !vals.every((v) => isStr(v) && v.length > 0 && v.length <= 60)) {
                c.add(`${fp}.values`, "enum needs 1-50 text values (max 60 characters each)");
            } else field.values = [...new Set(vals)];
        }
        return field;
    }).filter(Boolean);

    return { name, fields: outFields, access: rules };
}

// ---------- record validation ----------
/**
 * Checks a record body against a collection schema. Unknown keys are rejected (never
 * stored), every value has the declared type, so nothing reaches MongoDB as an operator.
 */
function validateRecord(collection, body, { partial = false } = {}) {
    const c = new Checker();
    if (!isObj(body)) {
        c.add("body", "Send the record as a JSON object").done();
    }
    const byName = Object.fromEntries(collection.fields.map((f) => [f.name, f]));
    for (const k of Object.keys(body)) if (!byName[k]) c.add(k, `Unknown field "${k}"`);
    const out = {};
    for (const f of collection.fields) {
        const has = Object.prototype.hasOwnProperty.call(body, f.name);
        const v = body[f.name];
        if (!has || v === null || v === "") {
            if (f.required && (!partial || has)) c.add(f.name, `${f.name} is required`);
            else if (has) out[f.name] = null;
            continue;
        }
        const r = coerce(f, v);
        if (r.error) c.add(f.name, `${f.name}: ${r.error}`);
        else out[f.name] = r.value;
    }
    c.done();
    if (Buffer.byteLength(JSON.stringify(out)) > limits.recordBytes) {
        throw fail(413, "record_too_large", `A record may be at most ${limits.recordBytes / 1024} KB.`);
    }
    return out;
}

function coerce(f, v) {
    switch (f.type) {
        case "string":
        case "text":
            if (!isStr(v)) return { error: "must be text" };
            if (v.length > f.maxLength) return { error: `at most ${f.maxLength} characters` };
            return { value: v };
        case "email":
            if (!isStr(v) || v.length > 254 || !validator.isEmail(v)) return { error: "must be an email address" };
            return { value: v.trim().toLowerCase() };
        case "url":
            if (!isStr(v) || v.length > 2000 || !validator.isURL(v, { protocols: ["http", "https"], require_protocol: true })) {
                return { error: "must be an http(s) URL" };
            }
            return { value: v };
        case "number":
        case "integer":
            if (typeof v !== "number" || !Number.isFinite(v)) return { error: "must be a number" };
            if (f.type === "integer" && !Number.isInteger(v)) return { error: "must be a whole number" };
            if (f.min !== undefined && v < f.min) return { error: `at least ${f.min}` };
            if (f.max !== undefined && v > f.max) return { error: `at most ${f.max}` };
            return { value: v };
        case "boolean":
            if (typeof v !== "boolean") return { error: "must be true or false" };
            return { value: v };
        case "date": {
            if (!isStr(v) || !validator.isISO8601(v)) return { error: "must be an ISO date, e.g. 2026-10-23 or 2026-10-23T14:00:00Z" };
            return { value: new Date(v).toISOString() };
        }
        case "enum":
            if (!isStr(v) || !f.values.includes(v)) return { error: `must be one of ${f.values.join(", ")}` };
            return { value: v };
        case "string_list":
            if (!Array.isArray(v) || v.length > f.maxItems || !v.every((x) => isStr(x) && x.length <= f.maxLength)) {
                return { error: `must be a list of at most ${f.maxItems} texts (max ${f.maxLength} characters each)` };
            }
            return { value: v };
        case "file":
            if (!isStr(v) || !/^[0-9a-f]{32}$/.test(v)) return { error: "must be a file id from POST /files" };
            return { value: v };
        default:
            return { error: "unsupported type" };
    }
}

/** Query-string value -> typed value for an equality filter (or an error). */
function filterValue(f, raw) {
    if (!isStr(raw) || raw.length > 500) return { error: "invalid filter" };
    switch (f.type) {
        case "number":
        case "integer": {
            const n = Number(raw);
            return Number.isFinite(n) ? { value: n } : { error: "must be a number" };
        }
        case "boolean":
            return raw === "true" || raw === "false" ? { value: raw === "true" } : { error: "must be true or false" };
        case "string_list":
            return { value: raw }; // matches lists that contain it
        case "date":
            return validator.isISO8601(raw) ? { value: new Date(raw).toISOString() } : { error: "must be an ISO date" };
        default:
            return { value: f.type === "email" ? raw.toLowerCase() : raw };
    }
}

// ---------- DTOs ----------
const toDeveloperDTO = (d) => ({
    id: String(d._id), email: d.email, name: d.name ?? null, created_at: d.createdAt,
});

const collectionToDTO = (col) => ({
    name: col.name,
    access: { read: col.access.read, create: col.access.create, update: col.access.update, delete: col.access.delete },
    fields: col.fields.map((f) => ({
        name: f.name, type: f.type, required: Boolean(f.required),
        ...(f.maxLength ? { max_length: f.maxLength } : {}),
        ...(f.maxItems ? { max_items: f.maxItems } : {}),
        ...(f.min !== undefined && f.min !== null ? { min: f.min } : {}),
        ...(f.max !== undefined && f.max !== null ? { max: f.max } : {}),
        ...(f.values && f.values.length ? { values: [...f.values] } : {}),
    })),
});

function toAppDTO(a, { origin } = {}) {
    const base = `${origin || ""}/api/v1/apps/${a.slug}`;
    return {
        id: String(a._id),
        name: a.name,
        slug: a.slug,
        description: a.description ?? null,
        frontend_urls: a.frontendOrigins,
        allow_localhost: a.allowLocalhost,
        features: { auth: a.features?.auth !== false, files: Boolean(a.features?.files) },
        collections: a.collections.map(collectionToDTO),
        publishable_key: a.publishableKey,
        secret_key_hint: a.secretKeyHint,
        is_active: a.isActive,
        api_base: base,
        docs_url: `${base}/docs`,
        created_at: a.createdAt,
        updated_at: a.updatedAt,
    };
}

const toAppUserDTO = (u) => ({ id: String(u._id), email: u.email, name: u.name ?? null, created_at: u.createdAt });

function toRecordDTO(r) {
    return {
        id: String(r._id),
        ...r.data,
        owner_id: r.ownerId ? String(r.ownerId) : null,
        created_at: r.createdAt,
        updated_at: r.updatedAt,
    };
}

module.exports = {
    CHANGE_RULES,
    CREATE_RULES,
    Checker,
    FIELD_TYPES,
    READ_RULES,
    PlatformError,
    clientIp,
    collectionToDTO,
    fail,
    filterValue,
    isLocalOrigin,
    isObj,
    isStr,
    limits,
    newPublishableKey,
    newSecretKey,
    originOf,
    passwordProblem,
    rateLimit,
    safeEqual,
    sha256,
    slugify,
    RESERVED_SLUGS,
    SLUG_RE,
    toAppDTO,
    toAppUserDTO,
    toDeveloperDTO,
    toRecordDTO,
    validateAppSpec,
    validateRecord,
};
