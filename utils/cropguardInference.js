const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { config } = require("./cropguard.js");
const { InvalidImageError, loadImage, preprocessEval } = require("./cropguardPreprocess.js");

// GhanaCropGuard model serving with ONNX Runtime (onnxruntime-node, CPU).
// The bundle (model.onnx + meta.json) is produced by ghanacropguard-ai's
// `python -m cropguard_ml.export`; copy artifacts/models/active into
// CROPGUARD_MODEL_DIR (default data/cropguard/model). There is no fallback or
// fake prediction: without a valid bundle the prediction routes answer 503.

class ModelUnavailableError extends Error {}

class Classifier {
    static async load(dir, threads) {
        const metaPath = path.join(dir, "meta.json");
        const onnxPath = path.join(dir, "model.onnx");
        if (!fs.existsSync(metaPath) || !fs.existsSync(onnxPath)) {
            throw new ModelUnavailableError(`Model bundle not found in ${dir}`);
        }
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const bytes = fs.readFileSync(onnxPath);
        const expected = meta.files?.["model.onnx"]?.sha256;
        if (expected && crypto.createHash("sha256").update(bytes).digest("hex") !== expected) {
            throw new ModelUnavailableError("model.onnx hash does not match meta.json");
        }
        // Required here, not at the top, so a platform without the native module
        // only loses CropGuard predictions instead of the whole server.
        const ort = require("onnxruntime-node");
        const options = { executionProviders: ["cpu"], graphOptimizationLevel: "all" };
        if (threads) options.intraOpNumThreads = threads;
        const session = await ort.InferenceSession.create(bytes, options);
        const clf = new Classifier(ort, session, meta);
        // Warm-up so the first user request is not slow; also checks the output size.
        const size = clf.cfg.image_size;
        const out = await clf.run(new Float32Array(3 * size * size));
        if (out.length !== clf.classes.length) {
            throw new ModelUnavailableError("Model output size does not match class list");
        }
        return clf;
    }

    constructor(ort, session, meta) {
        this.ort = ort;
        this.session = session;
        this.meta = meta;
        this.cfg = meta.preprocess;
        this.classes = [...meta.classes].sort((a, b) => a.index - b.index);
        this.inputName = session.inputNames[0];
        this.outputName = session.outputNames[0];
    }

    get version() {
        return this.meta.name;
    }

    async run(x) {
        const size = this.cfg.image_size;
        const tensor = new this.ort.Tensor("float32", x, [1, 3, size, size]);
        const result = await this.session.run({ [this.inputName]: tensor });
        return result[this.outputName].data;
    }

    async predict(buffer, { maxPixels, lowConf, smallMargin, topK = 3 }) {
        const t0 = process.hrtime.bigint();
        const img = await loadImage(buffer, maxPixels); // throws InvalidImageError
        const logits = Array.from(await this.run(preprocessEval(img, this.cfg)));
        const max = Math.max(...logits);
        const exps = logits.map((l) => Math.exp(l - max));
        const sum = exps.reduce((a, b) => a + b, 0);
        const probs = exps.map((e) => e / sum);
        const order = probs.map((p, i) => i).sort((a, b) => probs[b] - probs[a] || a - b);
        const k = Math.min(topK, order.length);
        const tops = order.slice(0, k).map((i) => {
            const c = this.classes[i];
            return {
                class_key: c.key,
                crop: c.crop,
                display_name: c.display_name,
                kind: c.kind,
                confidence: Number(probs[i].toFixed(4)),
            };
        });
        const best = tops[0];
        const warnings = [];
        if (best.confidence < lowConf) warnings.push("low_confidence");
        if (k > 1 && best.confidence - tops[1].confidence < smallMargin) warnings.push("close_alternatives");
        if (k > 1 && tops[1].crop !== best.crop && tops[1].confidence >= 0.15) warnings.push("crop_uncertain");
        if (Math.min(img.width, img.height) < 160) warnings.push("low_resolution");
        return {
            classKey: best.class_key,
            crop: best.crop,
            confidence: best.confidence,
            topK: tops,
            warnings,
            processingMs: Math.round(Number(process.hrtime.bigint() - t0) / 1e5) / 10,
            imageWidth: img.width,
            imageHeight: img.height,
        };
    }
}

// Holds the single classifier, loaded once when this module is first required.
const registry = {
    classifier: null,
    error: "Model is loading",
    ready: null,
    async load(dir = config.modelDir) {
        try {
            this.classifier = await Classifier.load(dir, config.ortThreads);
            this.error = null;
            console.log(`[cropguard] model loaded: ${this.classifier.version}`);
        } catch (err) {
            this.classifier = null;
            this.error = err instanceof ModelUnavailableError ? err.message : `Failed to load model: ${err.name}`;
            console.error(`[cropguard] model NOT loaded (${this.error}); predictions will return 503`);
        }
    },
    get() {
        if (!this.classifier) throw new ModelUnavailableError(this.error || "Model not loaded");
        return this.classifier;
    },
};
registry.ready = registry.load();

module.exports = { Classifier, InvalidImageError, ModelUnavailableError, registry };
