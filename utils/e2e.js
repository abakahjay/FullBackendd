// End-to-end encrypted Nsoro messages: the server only stores and relays the
// envelope the sender's device built (see Nsoro src/utils/e2e.js). This checks its
// shape and size; it can't (and doesn't try to) read it.
const { BadRequestError } = require('../errors');

const B64 = /^[A-Za-z0-9+/=_-]+$/;
const MAX_ENVELOPE = 96 * 1024; // ~70 KB of text after encryption overhead
const MAX_DEVICES = 40; // recipient's + sender's devices

const str = (v, max) => typeof v === 'string' && v.length > 0 && v.length <= max && B64.test(v);

// Returns a clean copy of the envelope, or null when there isn't one.
function cleanEnvelope(raw) {
    if (raw == null || raw === '') return null;
    let e = raw;
    if (typeof e === 'string') {
        try { e = JSON.parse(e); } catch { throw new BadRequestError('Invalid encrypted message.'); }
    }
    const ok = e && e.v === 1
        && str(e.sd, 64) && str(e.spk, 200) && str(e.iv, 32)
        && (e.ct === undefined || str(e.ct, MAX_ENVELOPE))
        && Array.isArray(e.keys) && e.keys.length > 0 && e.keys.length <= MAX_DEVICES
        && e.keys.every((k) => k && str(k.d, 64) && str(k.k, 100));
    if (!ok) throw new BadRequestError('Invalid encrypted message.');
    const clean = { v: 1, sd: e.sd, spk: e.spk, iv: e.iv, keys: e.keys.map((k) => ({ d: k.d, k: k.k })) };
    if (e.ct !== undefined) clean.ct = e.ct;
    if (typeof e.mime === 'string' && /^audio\/[\w.+-]+(;\s*codecs=[\w.,"' -]+)?$/.test(e.mime) && e.mime.length <= 80) clean.mime = e.mime;
    if (JSON.stringify(clean).length > MAX_ENVELOPE) throw new BadRequestError('Message is too long.');
    return clean;
}

module.exports = { cleanEnvelope };
