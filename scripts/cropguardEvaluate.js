// Independent accuracy check of the CropGuard model exactly as the server runs it:
// the bundle in CROPGUARD_MODEL_DIR (default data/cropguard/model) through
// utils/cropguardInference.js Classifier.predict(), i.e. the same decode, EXIF
// rotation, Pillow-exact resize, ONNX run and leaf check a real upload gets.
//
//   node scripts/cropguardEvaluate.js <ml-data-dir> [--split test] [--negatives 600] [--out report.json]
//
// <ml-data-dir> is ghanacropguard-ai/ml/data (needs prepared/splits.csv, raw/ and,
// for the leaf-check test, negatives/). Only the held-out split is used: these photos
// were never seen in training or model selection.
//
// Reports accuracy, top-3, per-class precision / recall (= sensitivity) / specificity /
// F1 with 95% Wilson intervals, macro and weighted averages, the confusion pairs,
// calibration (ECE), how often the app's warnings fire, and the leaf check
// (real leaves accepted, non-leaf photos refused).
const fs = require("fs");
const path = require("path");
const { Classifier } = require("../utils/cropguardInference.js");
const { config } = require("../utils/cropguard.js");

const args = process.argv.slice(2);
const dataDir = args.find((a) => !a.startsWith("--"));
const opt = (name, def) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : def;
};
if (!dataDir) {
    console.error("Usage: node scripts/cropguardEvaluate.js <ghanacropguard-ai/ml/data> [--split test] [--negatives 600] [--out report.json]");
    process.exit(1);
}
const SPLIT = opt("split", "test");
const NEG = Number(opt("negatives", 600));
const OUT = opt("out", null);

function parseCsv(text) {
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
        if (!line) continue;
        const cells = [];
        let cur = "";
        let q = false;
        for (let i = 0; i < line.length; i += 1) {
            const ch = line[i];
            if (q) {
                if (ch === '"' && line[i + 1] === '"') { cur += '"'; i += 1; } else if (ch === '"') q = false; else cur += ch;
            } else if (ch === '"') q = true;
            else if (ch === ",") { cells.push(cur); cur = ""; } else cur += ch;
        }
        cells.push(cur);
        rows.push(cells);
    }
    const [head, ...body] = rows;
    return body.map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// 95% Wilson score interval for a proportion k/n.
function wilson(k, n) {
    if (!n) return [null, null];
    const z = 1.96;
    const p = k / n;
    const d = 1 + (z * z) / n;
    const c = (p + (z * z) / (2 * n)) / d;
    const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
    return [c - h, c + h];
}
const r3 = (x) => (x === null || Number.isNaN(x) ? null : Math.round(x * 1000) / 1000);
const pct = (x) => (x === null ? "  -  " : `${(x * 100).toFixed(1).padStart(5)}%`);

function listImages(dir, out = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) listImages(p, out);
        else if (/\.(jpe?g|png|webp)$/i.test(e.name)) out.push(p);
    }
    return out;
}

(async () => {
    const modelDir = config.modelDir;
    const clf = await Classifier.load(modelDir, config.ortThreads);
    const keys = clf.classes.map((c) => c.key);
    const crop = Object.fromEntries(clf.classes.map((c) => [c.key, c.crop]));
    const idx = Object.fromEntries(keys.map((k, i) => [k, i]));
    const rows = parseCsv(fs.readFileSync(path.join(dataDir, "prepared", "splits.csv"), "utf8")).filter((r) => r.split === SPLIT);
    console.log(`model ${clf.version} from ${modelDir}; ${rows.length} ${SPLIT} photos, ${keys.length} classes`);

    const K = keys.length;
    const cm = Array.from({ length: K }, () => new Array(K).fill(0));
    let top3 = 0;
    let leafAccepted = 0;
    let warned = 0;
    let errors = 0;
    const bins = Array.from({ length: 15 }, () => ({ n: 0, conf: 0, correct: 0 }));
    const ms = [];
    const wrongCrop = { n: 0 };
    const t0 = Date.now();
    for (let i = 0; i < rows.length; i += 1) {
        const r = rows[i];
        let p;
        try {
            p = await clf.predict(fs.readFileSync(path.join(dataDir, "raw", r.rel)), {
                maxPixels: config.maxImagePixels, lowConf: config.lowConfidence, smallMargin: config.smallMargin,
            });
        } catch (e) {
            errors += 1;
            continue;
        }
        const t = idx[r.label];
        const y = idx[p.classKey];
        cm[t][y] += 1;
        if (p.topK.some((c) => c.class_key === r.label)) top3 += 1;
        if (p.isLeaf) leafAccepted += 1;
        if (p.warnings.some((w) => ["low_confidence", "close_alternatives", "crop_uncertain"].includes(w))) warned += 1;
        if (crop[p.classKey] !== crop[r.label]) wrongCrop.n += 1;
        const b = Math.min(14, Math.floor(p.confidence * 15));
        bins[b].n += 1;
        bins[b].conf += p.confidence;
        bins[b].correct += t === y ? 1 : 0;
        ms.push(p.processingMs);
        if ((i + 1) % 500 === 0) console.log(`  ${i + 1}/${rows.length} (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }

    const N = cm.flat().reduce((a, b) => a + b, 0);
    const correct = keys.reduce((s, _, i) => s + cm[i][i], 0);
    const per = keys.map((k, i) => {
        const tp = cm[i][i];
        const support = cm[i].reduce((a, b) => a + b, 0);
        const predicted = cm.reduce((s, row) => s + row[i], 0);
        const fn = support - tp;
        const fp = predicted - tp;
        const tn = N - tp - fn - fp;
        const precision = predicted ? tp / predicted : null;
        const recall = support ? tp / support : null;
        const specificity = tn + fp ? tn / (tn + fp) : null;
        const f1 = precision && recall ? (2 * precision * recall) / (precision + recall) : 0;
        return { class: k, crop: crop[k], support, tp, fp, fn, precision, recall, specificity, f1, recall_ci95: wilson(tp, support), precision_ci95: wilson(tp, predicted) };
    });
    const mean = (f) => per.reduce((s, c) => s + (c[f] ?? 0), 0) / K;
    const wmean = (f) => per.reduce((s, c) => s + (c[f] ?? 0) * c.support, 0) / N;
    const ece = bins.reduce((s, b) => s + (b.n ? (b.n / N) * Math.abs(b.correct / b.n - b.conf / b.n) : 0), 0);
    const pairs = [];
    for (let i = 0; i < K; i += 1) for (let j = 0; j < K; j += 1) if (i !== j && cm[i][j]) pairs.push({ true: keys[i], pred: keys[j], count: cm[i][j] });
    pairs.sort((a, b) => b.count - a.count);

    // Leaf check on photos that are not crop leaves at all (should be refused).
    let neg = null;
    const negDir = path.join(dataDir, "negatives");
    if (NEG > 0 && fs.existsSync(negDir) && clf.leafOutput) {
        const all = listImages(negDir);
        // deterministic spread over the folder (no randomness: re-runs give the same numbers)
        const step = Math.max(1, Math.floor(all.length / NEG));
        const pick = all.filter((_, i) => i % step === 0).slice(0, NEG);
        let refused = 0;
        let n = 0;
        for (const f of pick) {
            try {
                const p = await clf.predict(fs.readFileSync(f), { maxPixels: config.maxImagePixels, lowConf: config.lowConfidence, smallMargin: config.smallMargin });
                n += 1;
                if (!p.isLeaf) refused += 1;
            } catch {
                // undecodable files are refused by the API anyway
            }
        }
        neg = { n, refused, refused_rate: n ? refused / n : null, refused_ci95: wilson(refused, n), note: "negatives/ may overlap the photos the leaf check was fitted on; the meta.json test figure uses a held-out set" };
    }

    const sorted = [...ms].sort((a, b) => a - b);
    const report = {
        model: clf.version,
        split: SPLIT,
        n: N,
        decode_errors: errors,
        accuracy: correct / N,
        accuracy_ci95: wilson(correct, N),
        top3_accuracy: top3 / N,
        macro: { precision: mean("precision"), recall_sensitivity: mean("recall"), specificity: mean("specificity"), f1: mean("f1") },
        weighted: { precision: wmean("precision"), recall_sensitivity: wmean("recall"), f1: wmean("f1") },
        wrong_crop_rate: wrongCrop.n / N,
        ece_15bin: ece,
        warning_rate: warned / N,
        leaf_check: { real_leaves_accepted: leafAccepted / N, not_leaf: neg },
        latency_ms: { p50: sorted[Math.floor(sorted.length * 0.5)], p95: sorted[Math.floor(sorted.length * 0.95)] },
        per_class: per,
        top_confusions: pairs.slice(0, 15),
        reported_in_meta: clf.meta.test_metrics ? {
            accuracy: clf.meta.test_metrics.accuracy, precision_macro: clf.meta.test_metrics.precision_macro,
            recall_macro: clf.meta.test_metrics.recall_macro, f1_macro: clf.meta.test_metrics.f1_macro,
        } : null,
    };

    console.log(`\naccuracy ${pct(report.accuracy)} (95% CI ${pct(report.accuracy_ci95[0])}-${pct(report.accuracy_ci95[1])})  top-3 ${pct(report.top3_accuracy)}  wrong crop ${pct(report.wrong_crop_rate)}  ECE ${r3(ece)}`);
    console.log(`macro    precision ${pct(report.macro.precision)}  recall/sensitivity ${pct(report.macro.recall_sensitivity)}  specificity ${pct(report.macro.specificity)}  F1 ${pct(report.macro.f1)}`);
    console.log(`weighted precision ${pct(report.weighted.precision)}  recall/sensitivity ${pct(report.weighted.recall_sensitivity)}  F1 ${pct(report.weighted.f1)}`);
    console.log(`leaf check: real leaves accepted ${pct(report.leaf_check.real_leaves_accepted)}${neg ? `, non-leaf photos refused ${pct(neg.refused_rate)} of ${neg.n}` : ""}; warnings shown on ${pct(report.warning_rate)} of answers; latency p50 ${report.latency_ms.p50} ms, p95 ${report.latency_ms.p95} ms`);
    console.log(`\n${"class".padEnd(34)} ${"n".padStart(4)}  precision  recall   (95% CI)        specif.   F1`);
    for (const c of [...per].sort((a, b) => a.f1 - b.f1)) {
        console.log(`${c.class.padEnd(34)} ${String(c.support).padStart(4)}  ${pct(c.precision)}    ${pct(c.recall)}  (${pct(c.recall_ci95[0])}-${pct(c.recall_ci95[1])})  ${pct(c.specificity)}  ${pct(c.f1)}`);
    }
    console.log("\nmost common mix-ups (true -> predicted):");
    for (const p of pairs.slice(0, 10)) console.log(`  ${String(p.count).padStart(3)}  ${p.true} -> ${p.pred}`);
    if (OUT) {
        fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
        console.log(`\nfull report: ${OUT}`);
    }
})().catch((e) => {
    console.error(e);
    process.exit(1);
});
