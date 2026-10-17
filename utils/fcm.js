const jwt = require('jsonwebtoken');
const FcmToken = require('../models/FcmToken');

// Native push for the Nsoro Android app (Firebase Cloud Messaging, HTTP v1).
// Web Push goes through Chrome, which Samsung and other phones put to sleep, so
// a closed app never heard a call. FCM wakes the app itself: its
// NsoroMessagingService rings and shows the full-screen call screen.
//
// Needs FIREBASE_SERVICE_ACCOUNT on Render: the whole service-account JSON
// (Firebase console → Project settings → Service accounts → Generate new private key).
// Without it every function here quietly does nothing.

let account;
const getAccount = () => {
    if (account !== undefined) return account;
    try {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT || '';
        account = raw ? JSON.parse(raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8')) : null;
    } catch (err) {
        console.error('FIREBASE_SERVICE_ACCOUNT is not valid JSON:', err.message);
        account = null;
    }
    return account;
};

const fcmEnabled = () => Boolean(getAccount()?.private_key);

let cachedToken = null; // { value, expiresAt }
async function accessToken() {
    if (cachedToken && cachedToken.expiresAt > Date.now() + 60000) return cachedToken.value;
    const sa = getAccount();
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
        { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 },
        sa.private_key,
        { algorithm: 'RS256' }
    );
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`FCM auth failed: ${body.error_description || body.error || res.status}`);
    cachedToken = { value: body.access_token, expiresAt: Date.now() + body.expires_in * 1000 };
    return cachedToken.value;
}

/**
 * Send a data message to every Nsoro app this user is signed in on.
 * data: flat { key: string } map, read by the app's NsoroMessagingService.
 * Returns the number of devices reached; never throws.
 */
async function fcmToUser(userId, data, { ttlSeconds = 60 } = {}) {
    try {
        if (!fcmEnabled() || !userId) return 0;
        const tokens = await FcmToken.find({ userId }).lean();
        if (!tokens.length) return 0;
        const sa = getAccount();
        const auth = await accessToken();
        const flat = Object.fromEntries(Object.entries(data).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]));
        let delivered = 0;
        await Promise.all(tokens.map(async (t) => {
            const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: { token: t.token, data: flat, android: { priority: 'HIGH', ttl: `${ttlSeconds}s` } } }),
            });
            if (res.ok) {
                delivered++;
                FcmToken.updateOne({ _id: t._id }, { lastSuccessAt: new Date() }).catch(() => {});
                return;
            }
            const body = await res.json().catch(() => ({}));
            const code = body.error?.details?.find((d) => d.errorCode)?.errorCode || body.error?.status;
            if (res.status === 404 || code === 'UNREGISTERED' || code === 'INVALID_ARGUMENT') {
                await FcmToken.deleteOne({ _id: t._id }).catch(() => {}); // app uninstalled or token replaced
            } else {
                console.error('FCM send failed:', res.status, code || '', body.error?.message || '');
            }
        }));
        return delivered;
    } catch (err) {
        console.error('fcmToUser failed:', err.message);
        return 0;
    }
}

/** The app on this phone signed in as userId (one token per app install). */
async function saveFcmToken(userId, token, versionCode) {
    await FcmToken.findOneAndUpdate(
        { token },
        { userId, token, versionCode: Number(versionCode) || undefined },
        { upsert: true, setDefaultsOnInsert: true }
    );
}

const removeFcmToken = (token) => FcmToken.deleteOne({ token });

module.exports = { fcmEnabled, fcmToUser, saveFcmToken, removeFcmToken };
