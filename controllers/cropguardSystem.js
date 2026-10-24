const mongoose = require("mongoose");
const { registry } = require("../utils/cropguardInference.js");
const { CLASSES, config, content, fail, guidanceFor } = require("../utils/cropguard.js");

// GET /health
const health = async (req, res) => {
    let database = false;
    try {
        if (mongoose.connection.readyState === 1) {
            await mongoose.connection.db.command({ ping: 1 });
            database = true;
        }
    } catch {
        database = false;
    }
    const clf = registry.classifier;
    res.json({
        status: database && clf ? "ok" : "degraded",
        database,
        model_loaded: Boolean(clf),
        model_version: clf ? clf.version : null,
        model_error: registry.error,
        time: new Date(),
    });
};

// GET /model/info
const modelInfo = async (req, res) => {
    const clf = registry.classifier;
    if (!clf) throw fail(503, "model_unavailable", registry.error || "Model not loaded");
    const m = clf.meta;
    res.json({
        name: m.name,
        version: m.version,
        arch: m.arch,
        num_classes: m.num_classes,
        classes: m.classes,
        preprocess: m.preprocess,
        test_metrics: m.test_metrics ?? null,
        validation_best: m.validation_best ?? null,
        intended_use: m.intended_use || "",
        dataset: m.dataset ?? null,
        leaf_gate: m.leaf_gate ? { threshold: m.leaf_gate.threshold, validation: m.leaf_gate.validation, test: m.leaf_gate.test } : null,
        note: "These figures come from CCMT test photos the model never saw in training. They show "
            + "how it did on that data, not whether any one live result is right.",
    });
};

// GET /crops  - public crop/condition catalogue for the crop information pages
const crops = async (req, res) => {
    const out = {};
    for (const [key, ci] of Object.entries(CLASSES)) {
        const g = guidanceFor(key);
        (out[ci.crop] = out[ci.crop] || []).push({
            class_key: key, display_name: ci.display_name, kind: ci.kind,
            summary: g.summary, signs: g.signs, steps: g.steps, sources: g.sources,
        });
    }
    res.json({ crops: out, regions: content.regions });
};

// GET /policy  - account policy values shown on the sign-up forms
const policy = async (req, res) => {
    res.json({ min_age: config.minAge, terms_version: config.termsVersion });
};

module.exports = { crops, health, modelInfo, policy };
