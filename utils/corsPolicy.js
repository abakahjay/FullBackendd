// CORS for every app on this server.
//
// Any site may call the API (the apps authenticate with a Bearer header, which a
// foreign site cannot obtain). But browser *credentials* (the shared `token`
// cookie, `User-*` / `authToken-*` cookies) are only honoured for our own
// frontends: otherwise any web page a signed-in user visits could make
// credentialed requests and read the answers (e.g. POST /api/v1/auth/userId,
// which returns the auth cookie).
//
// Credentialed origins: localhost/127.0.0.1 on any port (development), the hosts
// on ALLOWED_REDIRECT_DOMAINS, each app's client URL from .env, the known
// production frontends below, and anything listed in CORS_ORIGINS
// (comma-separated origins or hostnames). Add a new cookie-using frontend there.

const KNOWN_FRONTENDS = [
    "https://gh-gpt.onrender.com",
    "https://nsoro-app.onrender.com",
    "https://portfolio-8jmo.onrender.com",
    "https://ghanacropguard-web.onrender.com",
];

const hostOf = (value) => {
    try {
        return new URL(value.includes("://") ? value : `https://${value}`).host.toLowerCase();
    } catch {
        return null;
    }
};

const trustedHosts = () => {
    const env = process.env;
    const list = [
        ...KNOWN_FRONTENDS,
        ...(env.ALLOWED_REDIRECT_DOMAINS || "").split(","),
        ...(env.CORS_ORIGINS || "").split(","),
        env.CLEANBRIDGE_CLIENT_URL,
        env.SEEDBRIDGE_CLIENT_URL,
        env.CROPGUARD_CLIENT_URL,
        env.GHGPT_PUBLIC_URL,
        env.CLIENT_URL_AI,
        env.REDIRECT_URL,
        env.ORIGIN,
    ];
    const entries = list.map((v) => String(v || "").trim().toLowerCase()).filter(Boolean);
    return {
        hosts: new Set(entries.filter((e) => !e.startsWith(".")).map(hostOf).filter(Boolean)),
        // ".example.com" = that domain and its subdomains (same rule as utils/oauthRedirect.js)
        suffixes: entries.filter((e) => e.startsWith(".") && e.length > 1),
    };
};

let cached = null;
function allowsCredentials(origin) {
    if (!origin) return false;
    let url;
    try {
        url = new URL(origin);
    } catch {
        return false; // includes the opaque "null" origin of sandboxed frames
    }
    if (!["http:", "https:"].includes(url.protocol)) return false;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return true;
    if (url.protocol !== "https:") return false;
    cached ||= trustedHosts();
    // Entries may be bare hostnames (port-less) or full origins.
    const host = url.hostname.toLowerCase();
    return cached.hosts.has(url.host.toLowerCase()) || cached.hosts.has(host)
        || cached.suffixes.some((s) => host === s.slice(1) || host.endsWith(s));
}

/** Options callback for the `cors` package. */
function corsOptions(req, callback) {
    const origin = req.header("Origin");
    callback(null, {
        origin: true, // reflect: Bearer-token calls work from anywhere
        credentials: allowsCredentials(origin),
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        maxAge: 600,
    });
}

module.exports = { allowsCredentials, corsOptions };
