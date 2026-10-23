// GhanaCropGuard unit tests (no database needed): node --test test/cropguard/
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const sharp = require("sharp");
const { TINY_MODEL } = require("./helpers.js");
const { Classifier, ModelUnavailableError } = require("../../utils/cropguardInference.js");
const { InvalidImageError, loadImage, preprocessEval, roundHalfEven } = require("../../utils/cropguardPreprocess.js");
const { CLASS_KEYS, content, guidanceFor } = require("../../utils/cropguard.js");

const copyModel = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cropguard-"));
    for (const f of ["model.onnx", "meta.json"]) fs.copyFileSync(path.join(TINY_MODEL, f), path.join(dir, f));
    return dir;
};

test("classifier loads and predicts", async () => {
    const clf = await Classifier.load(TINY_MODEL);
    const img = await sharp({ create: { width: 300, height: 200, channels: 3, background: "#0ae60a" } }).png().toBuffer();
    const r = await clf.predict(img, { maxPixels: 4e7, lowConf: 0.6, smallMargin: 0.15 });
    assert.equal(r.classKey, "cassava_mosaic");
    assert.equal(r.topK.length, 3);
    assert.equal(r.imageWidth, 300);
});

test("missing bundle, tampered model and class mismatch are refused", async () => {
    await assert.rejects(Classifier.load(path.join(os.tmpdir(), "no-such-model")), ModelUnavailableError);

    const tampered = copyModel();
    fs.appendFileSync(path.join(tampered, "model.onnx"), Buffer.from([0]));
    await assert.rejects(Classifier.load(tampered), /hash does not match/);

    const mismatch = copyModel();
    const metaPath = path.join(mismatch, "meta.json");
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    meta.classes = meta.classes.slice(0, 5);
    fs.writeFileSync(metaPath, JSON.stringify(meta));
    await assert.rejects(Classifier.load(mismatch), /does not match class list/);
});

test("decompression bomb and non-images are refused", async () => {
    const bomb = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: "#fff" } }).png().toBuffer();
    await assert.rejects(loadImage(bomb, 50e6), InvalidImageError);
    await assert.rejects(loadImage(Buffer.from("not an image"), 50e6), InvalidImageError);
});

test("preprocessing output shape and Python-style rounding", async () => {
    const img = await loadImage(await sharp({ create: { width: 517, height: 333, channels: 3, background: "#808080" } }).png().toBuffer(), 50e6);
    const x = preprocessEval(img, { image_size: 224, resize_size: 256, mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225] });
    assert.equal(x.length, 3 * 224 * 224);
    assert.equal(roundHalfEven(16.5), 16);
    assert.equal(roundHalfEven(17.5), 18);
    assert.equal(roundHalfEven(-0.5), -0);
});

test("guidance covers every class without dosages (content policy)", () => {
    assert.deepEqual(Object.keys(content.guidance.en).sort(), [...CLASS_KEYS].sort());
    const banned = ["ml per", "g per", "litre of", "kg/ha", "l/ha", "dosage", "guaranteed", "cure "];
    for (const k of CLASS_KEYS) {
        const g = guidanceFor(k);
        const text = (g.summary + g.steps.join(" ")).toLowerCase();
        assert.ok(!banned.some((b) => text.includes(b)), k);
        assert.ok(g.escalate);
    }
    const allowed = ["plantwiseplusknowledgebank.org", "www.iita.org", "www.fao.org", "mofa.gov.gh", "plantvillage.psu.edu"];
    for (const s of Object.values(content.sources)) assert.ok(allowed.includes(new URL(s.url).hostname), s.url);
});

test("tiny model hash matches its meta.json", () => {
    const meta = JSON.parse(fs.readFileSync(path.join(TINY_MODEL, "meta.json"), "utf8"));
    const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(TINY_MODEL, "model.onnx"))).digest("hex");
    assert.equal(hash, meta.files["model.onnx"].sha256);
});
