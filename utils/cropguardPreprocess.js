const sharp = require("sharp");

// GhanaCropGuard image preprocessing, ported from ghanacropguard-ai
// ml/cropguard_ml/preprocess.py so that serving matches training and evaluation:
// decode -> EXIF orientation -> RGB -> resize short side (PIL bicubic) -> centre
// crop -> /255 -> (x - mean) / std -> CHW float32.
// The resize is a line-for-line port of Pillow's resample.c (8-bit path). sharp's
// own resize is close but not identical, so it is only used to decode.

class InvalidImageError extends Error {}

// Python's round(): halves go to the nearest even number.
const roundHalfEven = (x) => {
    const r = Math.round(x);
    return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
};

const bicubic = (x) => {
    const a = -0.5;
    x = Math.abs(x);
    if (x < 1) return ((a + 2) * x - (a + 3)) * x * x + 1;
    if (x < 2) return (((x - 5) * x + 8) * x - 4) * a;
    return 0;
};

const PRECISION_BITS = 32 - 8 - 2;

// Pillow precompute_coeffs + normalize_coeffs_8bpc for one axis.
function coeffs(inSize, outSize) {
    const support0 = 2; // bicubic
    const scale = inSize / outSize;
    const filterscale = Math.max(scale, 1);
    const support = support0 * filterscale;
    const ksize = Math.ceil(support) * 2 + 1;
    const kk = new Int32Array(outSize * ksize);
    const bounds = new Int32Array(outSize * 2);
    const ss = 1 / filterscale;
    const prekk = new Float64Array(ksize);
    for (let xx = 0; xx < outSize; xx++) {
        const center = (xx + 0.5) * scale;
        let xmin = Math.trunc(center - support + 0.5);
        if (xmin < 0) xmin = 0;
        let xmax = Math.trunc(center + support + 0.5);
        if (xmax > inSize) xmax = inSize;
        xmax -= xmin;
        let ww = 0;
        for (let x = 0; x < xmax; x++) {
            const w = bicubic((x + xmin - center + 0.5) * ss);
            prekk[x] = w;
            ww += w;
        }
        for (let x = 0; x < ksize; x++) {
            const k = x < xmax ? (ww !== 0 ? prekk[x] / ww : prekk[x]) : 0;
            kk[xx * ksize + x] = k < 0
                ? Math.trunc(-0.5 + k * (1 << PRECISION_BITS))
                : Math.trunc(0.5 + k * (1 << PRECISION_BITS));
        }
        bounds[xx * 2] = xmin;
        bounds[xx * 2 + 1] = xmax;
    }
    return { kk, bounds, ksize };
}

const clip8 = (v) => {
    v = Math.floor(v / (1 << PRECISION_BITS));
    return v < 0 ? 0 : v > 255 ? 255 : v;
};

// Like Pillow's ImagingResample: horizontal pass, then vertical, rounding to
// 8 bits in between. `src` is packed RGB.
function resizeRGB(src, w, h, outW, outH) {
    let data = src;
    let curW = w;
    if (outW !== w) {
        const { kk, bounds, ksize } = coeffs(w, outW);
        const out = new Uint8Array(outW * h * 3);
        for (let y = 0; y < h; y++) {
            for (let xx = 0; xx < outW; xx++) {
                const xmin = bounds[xx * 2];
                const xmax = bounds[xx * 2 + 1];
                let r = 1 << (PRECISION_BITS - 1);
                let g = r;
                let b = r;
                for (let x = 0; x < xmax; x++) {
                    const k = kk[xx * ksize + x];
                    const i = (y * w + x + xmin) * 3;
                    r += data[i] * k;
                    g += data[i + 1] * k;
                    b += data[i + 2] * k;
                }
                const o = (y * outW + xx) * 3;
                out[o] = clip8(r);
                out[o + 1] = clip8(g);
                out[o + 2] = clip8(b);
            }
        }
        data = out;
        curW = outW;
    }
    if (outH !== h) {
        const { kk, bounds, ksize } = coeffs(h, outH);
        const out = new Uint8Array(curW * outH * 3);
        for (let yy = 0; yy < outH; yy++) {
            const ymin = bounds[yy * 2];
            const ymax = bounds[yy * 2 + 1];
            for (let x = 0; x < curW; x++) {
                let r = 1 << (PRECISION_BITS - 1);
                let g = r;
                let b = r;
                for (let y = 0; y < ymax; y++) {
                    const k = kk[yy * ksize + y];
                    const i = ((y + ymin) * curW + x) * 3;
                    r += data[i] * k;
                    g += data[i + 1] * k;
                    b += data[i + 2] * k;
                }
                const o = (yy * curW + x) * 3;
                out[o] = clip8(r);
                out[o + 1] = clip8(g);
                out[o + 2] = clip8(b);
            }
        }
        data = out;
    }
    return data;
}

// resize_short_side()
function resizeShortSide(img, size) {
    const { data, width: w, height: h } = img;
    if (Math.min(w, h) === size) return img;
    const scale = size / Math.min(w, h);
    const outW = Math.max(1, roundHalfEven(w * scale));
    const outH = Math.max(1, roundHalfEven(h * scale));
    return { data: resizeRGB(data, w, h, outW, outH), width: outW, height: outH };
}

// center_crop() + normalisation + HWC -> CHW.
function cropNormalize(img, size, mean, std) {
    const { data, width: w, height: h } = img;
    const left = roundHalfEven((w - size) / 2);
    const top = roundHalfEven((h - size) / 2);
    const out = new Float32Array(3 * size * size);
    const plane = size * size;
    const m = mean.map(Math.fround);
    const s = std.map(Math.fround);
    for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
            const sy = y + top;
            const sx = x + left;
            const inside = sy >= 0 && sy < h && sx >= 0 && sx < w;
            for (let c = 0; c < 3; c++) {
                const v = inside ? data[(sy * w + sx) * 3 + c] : 0; // PIL pads crops with black
                out[c * plane + y * size + x] = Math.fround(Math.fround(Math.fround(v / 255) - m[c]) / s[c]);
            }
        }
    }
    return out;
}

// load_image(): any decodable image -> packed RGB with EXIF orientation applied.
async function loadImage(buffer, maxPixels) {
    let meta;
    try {
        meta = await sharp(buffer, { limitInputPixels: false }).metadata();
    } catch {
        throw new InvalidImageError("Not a valid image");
    }
    if (!meta.width || !meta.height) throw new InvalidImageError("Not a valid image");
    if (meta.width * meta.height > maxPixels) throw new InvalidImageError("Image has too many pixels");
    try {
        const { data, info } = await sharp(buffer, { limitInputPixels: maxPixels, failOn: "error" })
            .rotate()
            .removeAlpha()
            .toColourspace("srgb")
            .raw()
            .toBuffer({ resolveWithObject: true });
        if (info.channels !== 3) throw new Error(`unexpected channels ${info.channels}`);
        return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
    } catch {
        throw new InvalidImageError("Not a valid image");
    }
}

// preprocess_eval(): RGB image -> Float32Array [3, size, size].
function preprocessEval(img, cfg) {
    const resized = resizeShortSide(img, cfg.resize_size);
    return cropNormalize(resized, cfg.image_size, cfg.mean, cfg.std);
}

module.exports = { InvalidImageError, loadImage, preprocessEval, resizeShortSide, roundHalfEven };
