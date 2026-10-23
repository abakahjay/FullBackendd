// Shared setup for the GhanaCropGuard tests (node --test test/cropguard/).
//
// The API tests start the real server (app.js) as a child process against a
// THROWAWAY database and talk to it over HTTP. Set CROPGUARD_TEST_MONGO_URI to a
// local MongoDB whose database name ends in _test or _tmp, e.g.
//   CROPGUARD_TEST_MONGO_URI=mongodb://127.0.0.1:27017/cropguard_test node --test test/cropguard/
// The tiny model in tiny-model/ is a real ONNX graph (global average pool +
// linear): mostly-green photos -> cassava_mosaic, mostly-red -> cashew_red_rust.
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const sharp = require("sharp");

const ROOT = path.join(__dirname, "..", "..");
const TINY_MODEL = path.join(__dirname, "tiny-model");
const MONGO = process.env.CROPGUARD_TEST_MONGO_URI || "";

function mongoProblem() {
    if (!MONGO) return "CROPGUARD_TEST_MONGO_URI is not set";
    let u;
    try {
        u = new URL(MONGO);
    } catch {
        return "CROPGUARD_TEST_MONGO_URI is not a URL";
    }
    const db = u.pathname.replace(/^\//, "");
    if (!["127.0.0.1", "localhost"].includes(u.hostname)) return "tests only run against a local MongoDB";
    if (!/_(test|tmp)$/.test(db)) return "the test database name must end in _test or _tmp";
    return null;
}

const freePort = () => new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, () => {
        const { port } = s.address();
        s.close(() => resolve(port));
    });
});

async function startServer(env = {}) {
    const port = await freePort();
    const child = spawn(process.execPath, ["app.js"], {
        cwd: ROOT,
        env: {
            ...process.env,
            MONGO_URI: MONGO,
            PORT: String(port),
            JWT_SECRET: "cropguard-test-secret-that-is-long-enough",
            JWT_LIFETIME: "1d",
            CROPGUARD_MODEL_DIR: TINY_MODEL,
            CROPGUARD_RATE_LIMIT_PREDICTIONS_PER_MINUTE: "1000",
            CROPGUARD_RATE_LIMIT_AUTH_PER_MINUTE: "1000",
            CROPGUARD_BOOTSTRAP_ADMIN_EMAIL: "admin@example.com",
            CROPGUARD_BOOTSTRAP_ADMIN_PASSWORD: "AdminPass123",
            CROPGUARD_CLIENT_URL: "https://cropguard-web.example.com",
            // Never send real email from tests (set-but-empty wins over .env).
            MAIL_RELAY_URL: "",
            BREVO_API_KEY: "",
            EMAIL_USER: "",
            EMAIL_PASS: "",
            ...env,
        },
        stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (d) => { log += d; });
    child.stderr.on("data", (d) => { log += d; });
    const base = `http://127.0.0.1:${port}/api/v1/cropguard`;
    const wantAdmin = (env.CROPGUARD_BOOTSTRAP_ADMIN_EMAIL ?? "admin@example.com") !== "";
    const deadline = Date.now() + 60000;
    for (;;) {
        if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
        try {
            const h = await (await fetch(`${base}/health`)).json();
            // wait for the model and the startup tasks (admin bootstrap)
            if (h.database && h.model_error !== "Model is loading") {
                if (!wantAdmin) break;
                const admin = await fetch(`${base}/auth/login`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ email: "admin@example.com", password: "AdminPass123" }),
                });
                if (admin.status === 200) break;
            }
        } catch {
            // not listening yet
        }
        if (Date.now() > deadline) {
            child.kill();
            throw new Error(`server did not become ready:\n${log}`);
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    return {
        base,
        origin: `http://127.0.0.1:${port}`,
        log: () => log,
        stop: () => new Promise((resolve) => {
            child.once("exit", resolve);
            child.kill();
        }),
    };
}

const CONSENT = { age_confirmed: true, accept_terms: true };
let counter = 0;

function client(srv) {
    const call = async (method, p, { token, json, form, headers = {} } = {}) => {
        const h = { ...headers };
        if (token) h.Authorization = `Bearer ${token}`;
        let body;
        if (json !== undefined) {
            h["Content-Type"] = "application/json";
            body = JSON.stringify(json);
        } else if (form) {
            body = form;
        }
        const url = p.startsWith("/api/") ? srv.origin + p : srv.base + p;
        const r = await fetch(url, { method, headers: h, body });
        const text = await r.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = text;
        }
        return { status: r.status, headers: r.headers, data, text };
    };
    const register = async (extra = {}) => {
        counter += 1;
        const email = `farmer${Date.now()}${counter}@example.com`;
        const r = await call("POST", "/auth/register", {
            json: { email, password: "Cassava2026", full_name: "Ama", ...CONSENT, ...extra },
        });
        if (r.status !== 201) throw new Error(`register failed: ${r.status} ${r.text}`);
        return { ...r.data, email };
    };
    const upload = (token, bytes, name = "leaf.jpg", type = "image/jpeg") => {
        const form = new FormData();
        form.append("image", new Blob([bytes], { type }), name);
        form.append("client", "web");
        return call("POST", "/predictions", { token, form });
    };
    return { call, register, upload };
}

const solid = (rgb, fmt = "jpeg", size = [640, 480]) =>
    sharp({ create: { width: size[0], height: size[1], channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } })
        .toFormat(fmt)
        .toBuffer();

module.exports = { CONSENT, MONGO, ROOT, TINY_MODEL, client, mongoProblem, solid, startServer };
