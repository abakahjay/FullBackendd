// Validates the environment once at boot (called first thing in app.js start()).
// Missing required variables stop the boot with a clear message, so Render/PM2 shows
// the real cause instead of the app crashing later on the first request.
// Weak secrets only warn, unless REQUIRE_STRONG_SECRETS=true (then they stop the boot too):
// rotating JWT_SECRET signs every user out, so that is the owner's call.

const REQUIRED = ['MONGO_URI', 'JWT_SECRET'];
const MIN_SECRET_LENGTH = 32;

// Recommended in production; each missing one disables a feature, not the server.
const RECOMMENDED_IN_PRODUCTION = [
    ['MAIL_RELAY_URL', 'password-reset and notification emails (Render blocks SMTP)'],
    ['MAIL_RELAY_SECRET', 'password-reset and notification emails'],
    ['PAYSTACK_SECRET_KEY', 'payments'],
    ['SESSION_KEY', 'express-session signing'],
];

function checkEnv(env = process.env) {
    const problems = [];
    const warnings = [];

    for (const key of REQUIRED) {
        if (!env[key] || !String(env[key]).trim()) problems.push(`${key} is not set`);
    }

    if (env.MONGO_URI && !/^mongodb(\+srv)?:\/\//.test(env.MONGO_URI)) {
        problems.push('MONGO_URI must start with mongodb:// or mongodb+srv://');
    }

    const weak = [];
    if (env.JWT_SECRET && env.JWT_SECRET.length < MIN_SECRET_LENGTH) weak.push('JWT_SECRET');
    if (env.SESSION_KEY && env.SESSION_KEY.length < MIN_SECRET_LENGTH) weak.push('SESSION_KEY');
    if (weak.length) {
        const msg = `${weak.join(', ')} shorter than ${MIN_SECRET_LENGTH} characters. Generate one with `
            + `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))". `
            + 'Changing JWT_SECRET signs everyone out.';
        if (env.REQUIRE_STRONG_SECRETS === 'true') problems.push(msg);
        else warnings.push(msg);
    }

    const production = env.NODE_ENV === 'production' || !!env.RENDER;
    if (production) {
        for (const [key, what] of RECOMMENDED_IN_PRODUCTION) {
            if (!env[key]) warnings.push(`${key} is not set: ${what} will not work`);
        }
    }

    return { ok: problems.length === 0, problems, warnings };
}

// Logs the result and returns false when the server must not start.
function assertEnv(env = process.env) {
    const { ok, problems, warnings } = checkEnv(env);
    for (const w of warnings) console.warn(`[env] warning: ${w}`);
    for (const p of problems) console.error(`[env] ${p}`);
    return ok;
}

module.exports = { checkEnv, assertEnv, MIN_SECRET_LENGTH };
