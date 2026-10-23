const mongoose = require("mongoose");
const PlatformApp = require("../models/PlatformApp.js");
const PlatformAppUser = require("../models/PlatformAppUser.js");
const PlatformRecord = require("../models/PlatformRecord.js");
const { suggest } = require("../utils/platformSuggest.js");
const { deleteAppFiles, storageUsed } = require("../utils/platformStorage.js");
const {
    RESERVED_SLUGS, SLUG_RE, fail, isStr, limits, newPublishableKey, newSecretKey, rateLimit, sha256, slugify,
    toAppDTO, validateAppSpec,
} = require("../utils/platform.js");

// Developer dashboard: /api/v1/platform/apps/*. Every query is scoped to the signed-in
// developer, so one developer can never see or change another's app (404, not 403).

const publicOrigin = () => (process.env.ORIGIN || "").replace(/\/$/, "");
const dto = (a) => toAppDTO(a, { origin: publicOrigin() });

async function ownApp(req) {
    const { appId } = req.params;
    if (!mongoose.isValidObjectId(appId)) throw fail(404, "not_found", "App not found.");
    const app = await PlatformApp.findOne({ _id: appId, developerId: req.developer._id });
    if (!app) throw fail(404, "not_found", "App not found.");
    return app;
}

async function uniqueSlug(base) {
    let slug = SLUG_RE.test(base) && !RESERVED_SLUGS.has(base) ? base : `app-${base}`.slice(0, 40).replace(/-+$/, "");
    if (!SLUG_RE.test(slug)) slug = `app-${Date.now().toString(36)}`;
    for (let i = 2; await PlatformApp.exists({ slug }); i += 1) slug = `${slug.replace(/-\d+$/, "")}-${i}`.slice(0, 40);
    return slug;
}

async function deleteAppData(app) {
    await PlatformRecord.deleteMany({ appId: app._id });
    await PlatformAppUser.deleteMany({ appId: app._id });
    await deleteAppFiles(app._id);
}

// GET /platform/apps
const listApps = async (req, res) => {
    const apps = await PlatformApp.find({ developerId: req.developer._id }).sort({ createdAt: -1 });
    res.json({ items: apps.map(dto) });
};

// POST /platform/apps  { name, slug?, description?, frontend_urls[], allow_localhost?, features?, collections? }
// -> 201 with the app and its secret key (shown this once).
const createApp = async (req, res) => {
    const spec = validateAppSpec(req.body);
    if (await PlatformApp.countDocuments({ developerId: req.developer._id }) >= limits.appsPerDeveloper) {
        throw fail(403, "app_limit", `You can have at most ${limits.appsPerDeveloper} apps.`);
    }
    if (spec.slug && await PlatformApp.exists({ slug: spec.slug })) {
        throw fail(409, "slug_taken", "That slug is taken.", { fields: [{ field: "slug", message: "That slug is taken" }] });
    }
    const secret = newSecretKey();
    let app;
    try {
        app = await PlatformApp.create({
            developerId: req.developer._id,
            name: spec.name,
            slug: spec.slug || await uniqueSlug(slugify(spec.name)),
            description: spec.description ?? null,
            frontendOrigins: spec.frontendOrigins,
            allowLocalhost: spec.allowLocalhost ?? true,
            features: { auth: spec.features?.auth ?? true, files: spec.features?.files ?? false },
            collections: spec.collections,
            publishableKey: newPublishableKey(),
            secretKeyHash: sha256(secret),
            secretKeyHint: `${secret.slice(0, 7)}…${secret.slice(-4)}`,
        });
    } catch (err) {
        if (err.code === 11000) throw fail(409, "slug_taken", "That slug is taken.");
        throw err;
    }
    res.status(201).json({ ...dto(app), secret_key: secret });
};

const getApp = async (req, res) => res.json(dto(await ownApp(req)));

// PATCH /platform/apps/:appId  (same keys as create; the slug never changes)
const updateApp = async (req, res) => {
    const app = await ownApp(req);
    const spec = validateAppSpec(req.body, { partial: true });
    if (spec.name !== undefined) app.name = spec.name;
    if (spec.description !== undefined) app.description = spec.description;
    if (spec.frontendOrigins !== undefined) app.frontendOrigins = spec.frontendOrigins;
    if (spec.allowLocalhost !== undefined) app.allowLocalhost = spec.allowLocalhost;
    if (spec.features) app.features = { auth: spec.features.auth ?? app.features.auth, files: spec.features.files ?? app.features.files };
    if (spec.collections !== undefined) {
        const kept = new Set(spec.collections.map((c) => c.name));
        const dropped = app.collections.map((c) => c.name).filter((n) => !kept.has(n));
        if (dropped.length) await PlatformRecord.deleteMany({ appId: app._id, collectionName: { $in: dropped } });
        app.collections = spec.collections;
    }
    await app.save();
    res.json(dto(app));
};

// POST /platform/apps/:appId/collections  { name, fields, access }  -> adds one collection
const addCollection = async (req, res) => {
    const app = await ownApp(req);
    const current = app.collections.map((c) => (typeof c.toObject === "function" ? c.toObject() : c));
    const toInput = (c) => ({
        name: c.name, access: c.access,
        fields: c.fields.map((f) => ({ name: f.name, type: f.type, required: f.required, max_length: f.maxLength, max_items: f.maxItems, min: f.min ?? undefined, max: f.max ?? undefined, values: f.values?.length ? f.values : undefined })),
    });
    const spec = validateAppSpec({ collections: [...current.map(toInput), req.body] }, { partial: true });
    app.collections = spec.collections;
    await app.save();
    res.status(201).json(dto(app));
};

// DELETE /platform/apps/:appId/collections/:name  -> removes it and its records
const removeCollection = async (req, res) => {
    const app = await ownApp(req);
    const name = req.params.name;
    if (!isStr(name) || !app.collections.some((c) => c.name === name)) throw fail(404, "not_found", "No such collection.");
    app.collections = app.collections.filter((c) => c.name !== name);
    await app.save();
    await PlatformRecord.deleteMany({ appId: app._id, collectionName: name });
    res.json(dto(app));
};

// POST /platform/apps/:appId/rotate-secret  -> new secret key (old one stops working)
const rotateSecret = async (req, res) => {
    const app = await ownApp(req);
    const secret = newSecretKey();
    app.secretKeyHash = sha256(secret);
    app.secretKeyHint = `${secret.slice(0, 7)}…${secret.slice(-4)}`;
    await app.save();
    res.json({ ...dto(app), secret_key: secret });
};

// POST /platform/apps/:appId/rotate-publishable-key
const rotatePublishable = async (req, res) => {
    const app = await ownApp(req);
    app.publishableKey = newPublishableKey();
    await app.save();
    res.json(dto(app));
};

// POST /platform/apps/:appId/sign-out-users  -> revokes every end-user session of the app
const signOutUsers = async (req, res) => {
    const app = await ownApp(req);
    app.userTokenVersion += 1;
    await app.save();
    res.status(204).end();
};

// GET /platform/apps/:appId/stats
const stats = async (req, res) => {
    const app = await ownApp(req);
    const [users, perCollection, bytes] = await Promise.all([
        PlatformAppUser.countDocuments({ appId: app._id }),
        PlatformRecord.aggregate([{ $match: { appId: app._id } }, { $group: { _id: "$collectionName", n: { $sum: 1 } } }]),
        storageUsed(app._id),
    ]);
    res.json({
        users,
        records: Object.fromEntries(perCollection.map((x) => [x._id, x.n])),
        storage_mb: Math.round((bytes / 1024 / 1024) * 100) / 100,
        limits: { records: limits.recordsPerApp, users: limits.usersPerApp, storage_mb: limits.storageMbPerApp },
    });
};

// POST /platform/apps/:appId/suggest  { description }  -> recommendations + a draft collection (not saved)
const suggestApi = async (req, res) => {
    const app = await ownApp(req);
    const d = req.body?.description;
    if (!isStr(d) || d.trim().length < 3 || d.length > 1000) {
        throw fail(422, "validation_error", "Describe what you want in 3-1000 characters", { fields: [{ field: "description", message: "Describe what you want in 3-1000 characters" }] });
    }
    rateLimit(`suggest:${req.developer._id}`, 30, 60 * 60);
    res.json(await suggest(d.trim(), app));
};

// DELETE /platform/apps/:appId  { confirm: "<slug>" }
const deleteApp = async (req, res) => {
    const app = await ownApp(req);
    if (req.body?.confirm !== app.slug) {
        throw fail(422, "validation_error", `Type the app's slug (${app.slug}) to confirm`, { fields: [{ field: "confirm", message: "Type the app's slug to confirm" }] });
    }
    await deleteAppData(app);
    await PlatformApp.deleteOne({ _id: app._id });
    res.status(204).end();
};

module.exports = {
    addCollection, createApp, deleteApp, deleteAppData, getApp, listApps, removeCollection, rotatePublishable, rotateSecret,
    signOutUsers, stats, suggestApi, updateApp,
};
