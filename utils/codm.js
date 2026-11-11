const crypto = require("crypto");
const { BadRequestError } = require("../errors");
const { normalizeGhanaPhone } = require("./ghana.js");
const { isAllowedRedirectUri } = require("./oauthRedirect.js");

// ---------------------------------------------------------------------------
// Event settings. Everything money- or capacity-related comes from here (the
// server), never from a request.
// ---------------------------------------------------------------------------
const num = (value, fallback) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback);

const eventConfig = () => ({
    name: process.env.CODM_EVENT_NAME || "CODM Campus Showdown",
    entryFeeGhs: num(process.env.CODM_ENTRY_FEE_GHS, 50),
    prizeGhs: num(process.env.CODM_PRIZE_GHS, 3000),
    teamSize: Math.round(num(process.env.CODM_TEAM_SIZE, 5)),
    maxTeams: Math.round(num(process.env.CODM_MAX_TEAMS, 32)),
    mode: process.env.CODM_MODE || "Multiplayer 5v5",
    // 5:00 PM Ghana time (UTC+0) on Saturday 21 November 2026.
    startsAt: process.env.CODM_STARTS_AT || "2026-11-21T17:00:00Z",
    // Team changes and payments stop at this moment (default: 2 h before start).
    registrationClosesAt: process.env.CODM_REGISTRATION_CLOSES_AT || "2026-11-21T15:00:00Z",
    venue: process.env.CODM_VENUE || "UMaT Campus, Tarkwa",
    contacts: {
        organiser: ["0257445431", "0532900914"],
        moderator: "0553088594",
        whatsappGroup: process.env.CODM_WHATSAPP_GROUP_URL || "https://chat.whatsapp.com/Jia9EajDqIOBd8sE2uz0xe",
    },
});

const registrationOpen = () => Date.now() < new Date(eventConfig().registrationClosesAt).getTime();

const pesewas = (cedis) => Math.round(cedis * 100);

// ---------------------------------------------------------------------------
// Input checks. The CODM router is mounted before the global xss/mongo-sanitize
// middleware (app.js), so every value is type-checked here before any query.
// ---------------------------------------------------------------------------
const text = (value, label, { min = 1, max = 120, pattern, patternMsg, optional = false } = {}) => {
    if (value === undefined || value === null || value === "") {
        if (optional) return null;
        throw new BadRequestError(`${label} is required`);
    }
    if (typeof value !== "string") throw new BadRequestError(`${label} must be text`);
    const v = value.trim().replace(/\s+/g, " ");
    if (v.length < min) throw new BadRequestError(`${label} must be at least ${min} characters`);
    if (v.length > max) throw new BadRequestError(`${label} must be at most ${max} characters`);
    if (pattern && !pattern.test(v)) throw new BadRequestError(patternMsg || `${label} is not valid`);
    return v;
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const email = (value) => text(value, "Email", { max: 120, pattern: EMAIL_RE, patternMsg: "Enter a valid email address" }).toLowerCase();

const password = (value, label = "Password") => {
    if (typeof value !== "string") throw new BadRequestError(`${label} is required`);
    if (value.length < 8 || value.length > 128) throw new BadRequestError(`${label} must be 8 to 128 characters`);
    if (!/[A-Za-z]/.test(value) || !/\d/.test(value)) throw new BadRequestError(`${label} must contain letters and numbers`);
    return value;
};

const phone = (value) => {
    const raw = text(value, "Phone number", { max: 20 });
    const normalized = normalizeGhanaPhone(raw);
    if (!normalized) throw new BadRequestError("Enter a valid Ghana mobile number, e.g. 024 123 4567");
    return normalized;
};

const ign = (value) => text(value, "In-game name", { min: 2, max: 20, pattern: /^[\p{L}\p{N} ._\-|]+$/u, patternMsg: "In-game name may use letters, numbers, spaces and . _ - |" });
const codmUid = (value) => text(typeof value === "number" ? String(value) : value, "CODM UID", { min: 6, max: 20, pattern: /^\d+$/, patternMsg: "CODM UID is the number in your game profile (digits only)" });
const teamName = (value) => text(value, "Team name", { min: 3, max: 24, pattern: /^[\p{L}\p{N} ._\-]+$/u, patternMsg: "Team name may use letters, numbers, spaces and . _ -" });
const teamTag = (value) => {
    const v = text(value, "Team tag", { min: 2, max: 5, pattern: /^[A-Za-z0-9]+$/, patternMsg: "Team tag is 2 to 5 letters or numbers", optional: true });
    return v ? v.toUpperCase() : null;
};
const inviteCode = (value) => text(value, "Invite code", { min: 6, max: 6, pattern: /^[A-Za-z0-9]{6}$/, patternMsg: "Invite codes are 6 letters/numbers" }).toUpperCase();
const objectId = (value, label = "id") => {
    if (typeof value !== "string" || !/^[a-f0-9]{24}$/i.test(value)) throw new BadRequestError(`Invalid ${label}`);
    return value;
};

// No 0/O/1/I so codes read cleanly over WhatsApp.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const newInviteCode = () => Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");

// Paystack sends the player back to the frontend: only our own sites.
const isAllowedCodmRedirect = (url) => {
    if (isAllowedRedirectUri(url)) return true;
    try {
        const client = new URL(process.env.CODM_CLIENT_URL);
        const target = new URL(url);
        return target.protocol === client.protocol && target.host === client.host;
    } catch {
        return false;
    }
};

// ---------------------------------------------------------------------------
// What the API returns. Never the password hash or token version.
// ---------------------------------------------------------------------------
const maskPhone = (p) => (p ? `${p.slice(0, 7)}•••${p.slice(-2)}` : null);

const toPlayerDTO = (p) => ({
    id: String(p._id),
    fullName: p.fullName,
    email: p.email,
    phone: p.phone,
    ign: p.ign,
    codmUid: p.codmUid,
    role: p.role,
    teamId: p.teamId ? String(p.teamId) : null,
    paid: !!p.paid,
    paidAt: p.paidAt,
    paymentChannel: p.paymentChannel,
    createdAt: p.createdAt,
});

// Team member as seen by teammates: no email, phone partly hidden.
const toMemberDTO = (p, captainId) => ({
    id: String(p._id),
    fullName: p.fullName,
    ign: p.ign,
    phone: maskPhone(p.phone),
    paid: !!p.paid,
    isCaptain: String(p._id) === String(captainId),
});

const teamStatus = (team, members) => {
    const size = eventConfig().teamSize;
    const paidCount = members.filter((m) => m.paid).length;
    return {
        memberCount: members.length,
        paidCount,
        spotsLeft: Math.max(0, size - members.length),
        confirmed: members.length === size && paidCount === size,
    };
};

// ---------------------------------------------------------------------------
// Micro-cache for the public read endpoints (event, teams board, bracket).
// When a crowd refreshes at once, each backend instance asks MongoDB at most
// once every few seconds per endpoint; requests in between share the answer
// (including one already in flight). Writes call clearPublicCache().
// ---------------------------------------------------------------------------
const cache = new Map();
const cachedPublic = (key, ttlMs, load) => {
    const hit = cache.get(key);
    const now = Date.now();
    if (hit && (hit.pending || hit.expires > now)) return hit.pending || Promise.resolve(hit.value);
    const pending = load().then(
        (value) => { cache.set(key, { value, expires: Date.now() + ttlMs }); return value; },
        (err) => { cache.delete(key); throw err; }
    );
    cache.set(key, { pending, expires: 0 });
    return pending;
};
const clearPublicCache = () => cache.clear();
const PUBLIC_CACHE_MS = Number(process.env.CODM_PUBLIC_CACHE_MS) || 4000;

module.exports = {
    cachedPublic, clearPublicCache, PUBLIC_CACHE_MS,
    eventConfig, registrationOpen, pesewas,
    check: { text, email, password, phone, ign, codmUid, teamName, teamTag, inviteCode, objectId },
    newInviteCode, isAllowedCodmRedirect,
    toPlayerDTO, toMemberDTO, teamStatus, maskPhone,
};
