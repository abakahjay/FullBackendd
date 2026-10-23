const mongoose = require("mongoose");
const CropGuardUser = require("../models/CropGuardUser.js");
const CropGuardPrediction = require("../models/CropGuardPrediction.js");
const CropGuardAuditEvent = require("../models/CropGuardAuditEvent.js");
const CropGuardModelVersion = require("../models/CropGuardModelVersion.js");
const { registry } = require("../utils/cropguardInference.js");
const { CLASSES, Checker, audit, fail, isStr } = require("../utils/cropguard.js");

const intParam = (c, field, v, d, min, max) => {
    if (v === undefined || v === "") return d;
    const n = isStr(v) && /^\d+$/.test(v) ? Number(v) : NaN;
    if (!Number.isInteger(n) || n < min || n > max) c.add(field, `${field} must be a whole number from ${min} to ${max}`);
    return n;
};

const countBy = async (match, field) => {
    const rows = await CropGuardPrediction.aggregate([{ $match: match }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
};

const round = (v, digits) => (v === null || v === undefined ? null : Number(v.toFixed(digits)));

// GET /statistics?days=30
// Live usage figures from the database. They do NOT measure accuracy: the true
// label of a live photo is unknown unless it is verified separately.
const statistics = async (req, res) => {
    const c = new Checker();
    const days = intParam(c, "days", req.query.days, 30, 1, 365);
    c.done();
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const P = CropGuardPrediction;
    const ok = { status: "success" };

    const [total, success, failed, failedBy, avgs, lowConf, volumeRows, crops, classRows, byClient, byModel, users] = await Promise.all([
        P.countDocuments({}),
        P.countDocuments(ok),
        P.countDocuments({ status: "failed" }),
        countBy({ status: "failed" }, "errorCode"),
        P.aggregate([{ $match: ok }, { $group: { _id: null, ms: { $avg: "$processingMs" }, conf: { $avg: "$confidence" } } }]),
        P.countDocuments({ status: "success", confidence: { $lt: 0.6 } }),
        P.aggregate([
            { $match: { createdAt: { $gte: since } } },
            { $group: { _id: { d: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, s: "$status" }, n: { $sum: 1 } } },
        ]),
        countBy(ok, "crop"),
        P.aggregate([{ $match: ok }, { $group: { _id: "$classKey", n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
        countBy({}, "client"),
        countBy(ok, "modelVersion"),
        CropGuardUser.countDocuments({}),
    ]);

    const byDay = {};
    for (const r of volumeRows) {
        const d = r._id.d;
        byDay[d] = byDay[d] || { date: d, success: 0, failed: 0 };
        byDay[d][r._id.s] = r.n;
    }
    const classes = classRows.map((r) => ({
        class_key: r._id,
        crop: CLASSES[r._id] ? CLASSES[r._id].crop : null,
        display_name: CLASSES[r._id] ? CLASSES[r._id].display_name : r._id,
        count: r.n,
    }));
    const clf = registry.classifier;
    res.json({
        generated_at: new Date(),
        window_days: days,
        live: {
            total_requests: total,
            successful_predictions: success,
            failed_requests: failed,
            failed_by_reason: failedBy,
            average_processing_ms: round(avgs[0]?.ms, 1),
            average_top1_confidence: round(avgs[0]?.conf, 4),
            low_confidence_predictions: lowConf,
            volume_by_day: Object.keys(byDay).sort().map((k) => byDay[k]),
            crop_distribution: crops,
            class_distribution: classes,
            most_frequent: classes.slice(0, 5),
            by_client: byClient,
            by_model_version: byModel,
            users,
        },
        model: {
            current_version: clf ? clf.version : null,
            loaded: Boolean(clf),
            error: registry.error,
            historical_test_metrics: clf ? clf.meta.test_metrics ?? null : null,
            historical_validation: clf ? clf.meta.validation_best ?? null : null,
        },
        note: "Historical metrics come from the held-out CCMT test split. Live counts are usage "
            + "figures only; correctness of live predictions is unknown without verified labels.",
    });
};

// GET /admin/users?page=&page_size=
const listUsers = async (req, res) => {
    const c = new Checker();
    const page = intParam(c, "page", req.query.page, 1, 1, 1e6);
    const pageSize = intParam(c, "page_size", req.query.page_size, 50, 1, 200);
    c.done();
    const [users, total] = await Promise.all([
        CropGuardUser.find({}).sort({ createdAt: -1 }).skip((page - 1) * pageSize).limit(pageSize),
        CropGuardUser.countDocuments({}),
    ]);
    const counts = await CropGuardPrediction.aggregate([
        { $match: { userId: { $in: users.map((u) => u._id) } } },
        { $group: { _id: "$userId", n: { $sum: 1 } } },
    ]);
    const n = Object.fromEntries(counts.map((r) => [String(r._id), r.n]));
    res.json({
        items: users.map((u) => ({
            id: String(u._id), email: u.email, full_name: u.fullName, role: u.role, region: u.region,
            is_active: u.isActive, created_at: u.createdAt, predictions: n[String(u._id)] || 0,
        })),
        total,
    });
};

// PATCH /admin/users/:userId  { role?: "user"|"admin", is_active?: boolean }
const updateUser = async (req, res) => {
    const b = req.body || {};
    const c = new Checker();
    if (b.role !== undefined && b.role !== null && !["user", "admin"].includes(b.role)) c.add("role", "role must be user or admin");
    if (b.is_active !== undefined && b.is_active !== null && typeof b.is_active !== "boolean") c.add("is_active", "is_active must be true or false");
    c.done();

    const admin = req.cropguardUser;
    const u = mongoose.isValidObjectId(req.params.userId) ? await CropGuardUser.findById(req.params.userId) : null;
    if (!u) throw fail(404, "not_found", "User not found.");
    const self = String(u._id) === String(admin._id);
    const changes = {};
    if (b.role !== undefined && b.role !== null) {
        if (self && b.role !== "admin") throw fail(400, "self_demotion", "You cannot remove your own admin role.");
        changes.role = u.role = b.role;
    }
    if (b.is_active !== undefined && b.is_active !== null) {
        if (self) throw fail(400, "self_disable", "You cannot deactivate yourself.");
        changes.is_active = u.isActive = b.is_active;
        u.tokenVersion += 1;
    }
    await u.save();
    await audit(admin._id, "admin.user_update", String(u._id), changes);
    res.json({ id: String(u._id), role: u.role, is_active: u.isActive });
};

// GET /admin/audit?limit=100
const auditLog = async (req, res) => {
    const c = new Checker();
    const limit = intParam(c, "limit", req.query.limit, 100, 1, 500);
    c.done();
    const rows = await CropGuardAuditEvent.find({}).sort({ createdAt: -1 }).limit(limit);
    res.json(rows.map((e) => ({
        id: String(e._id), actor_id: e.actorId ? String(e.actorId) : null, action: e.action,
        target: e.target, details: e.details, created_at: e.createdAt,
    })));
};

// GET /admin/models
const modelVersions = async (req, res) => {
    const rows = await CropGuardModelVersion.find({}).sort({ lastLoadedAt: -1 });
    res.json(rows.map((m) => ({
        name: m.name, version: m.version, arch: m.arch, num_classes: m.numClasses, is_active: m.isActive,
        test_metrics: m.testMetrics, first_loaded_at: m.firstLoadedAt, last_loaded_at: m.lastLoadedAt,
    })));
};

// Marks the loaded bundle as the active model version (startup).
async function registerModelVersion() {
    const clf = registry.classifier;
    if (!clf) return;
    const now = new Date();
    await CropGuardModelVersion.updateMany({ isActive: true }, { $set: { isActive: false } });
    await CropGuardModelVersion.updateOne(
        { name: clf.version },
        {
            $set: { isActive: true, lastLoadedAt: now },
            $setOnInsert: {
                version: clf.meta.version, arch: clf.meta.arch, numClasses: clf.meta.num_classes,
                metaJson: JSON.stringify(clf.meta), testMetrics: clf.meta.test_metrics ?? null, firstLoadedAt: now,
            },
        },
        { upsert: true }
    );
}

module.exports = { auditLog, listUsers, modelVersions, registerModelVersion, statistics, updateUser };
