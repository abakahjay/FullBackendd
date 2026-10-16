const jwt = require('jsonwebtoken');

// Delivery receipts for Web Push. The Nsoro service worker (public/push-sw.js)
// POSTs `ack.token` back to `ack.url` as soon as a push reaches the phone - even
// when the app is closed. That's how we know a device is online:
//   { kind: 'delivered', userId }  -> their messages get two grey ticks
//   { kind: 'ringing', callId }    -> the caller's screen says "Ringing…"
// The service worker can't read the user's login token, so the receipt carries
// its own short-lived signature instead.
const apiBase = () =>
    (process.env.PUBLIC_API_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 7004}`).replace(/\/$/, '');

const makeAck = (claims) => ({
    url: `${apiBase()}/api/v1/push/ack`,
    token: jwt.sign({ ...claims, purpose: 'push-ack' }, process.env.JWT_SECRET, { expiresIn: '1d' }),
});

const readAck = (token) => {
    try {
        const claims = jwt.verify(String(token || ''), process.env.JWT_SECRET);
        return claims.purpose === 'push-ack' ? claims : null;
    } catch {
        return null;
    }
};

module.exports = { makeAck, readAck };
