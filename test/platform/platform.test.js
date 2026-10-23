// Developer platform tests against the real server (see test/cropguard/helpers.js for the
// throwaway-database rules). Run: CROPGUARD_TEST_MONGO_URI=mongodb://127.0.0.1:27017/cropguard_test npm run test:platform
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { mongoProblem, solid, startServer } = require("../cropguard/helpers.js");

const skip = mongoProblem() || false;
let n = 0;
const uniq = () => `${Date.now().toString(36)}${(n += 1)}`;

describe("developer platform", { skip }, () => {
    let srv;
    const call = async (method, path, { token, key, origin, json, form, headers = {} } = {}) => {
        const h = { ...headers };
        if (token) h.Authorization = `Bearer ${token}`;
        if (key) h["X-App-Key"] = key;
        if (origin) h.Origin = origin;
        let body;
        if (json !== undefined) {
            h["Content-Type"] = "application/json";
            body = JSON.stringify(json);
        } else if (form) body = form;
        const r = await fetch(`${srv.origin}${path}`, { method, headers: h, body, redirect: "manual" });
        const text = await r.text();
        let data = null;
        try {
            data = text ? JSON.parse(text) : null;
        } catch {
            data = text;
        }
        return { status: r.status, data, headers: r.headers };
    };
    const P = "/api/v1/platform";
    const devSignup = async () => {
        const r = await call("POST", `${P}/auth/register`, { json: { email: `dev${uniq()}@example.com`, password: "Builder2026", accept_terms: true } });
        assert.equal(r.status, 201, JSON.stringify(r.data));
        return r.data.access_token;
    };
    const spec = () => ({
        name: `Shop ${uniq()}`,
        frontend_urls: ["https://shop.example.com"],
        allow_localhost: true,
        features: { auth: true, files: true },
        collections: [
            {
                name: "products",
                access: { read: "public", create: "admin", update: "admin", delete: "admin" },
                fields: [
                    { name: "name", type: "string", required: true, max_length: 50 },
                    { name: "price", type: "number", required: true, min: 0 },
                    { name: "category", type: "enum", values: ["food", "tools"] },
                ],
            },
            {
                name: "notes",
                access: { read: "owner", create: "signed_in" },
                fields: [{ name: "body", type: "text", required: true }, { name: "done", type: "boolean" }],
            },
            {
                name: "messages",
                access: { read: "admin", create: "public" },
                fields: [{ name: "email", type: "email", required: true }, { name: "message", type: "text", required: true }],
            },
        ],
    });

    before(async () => {
        srv = await startServer({ PLATFORM_AI_SUGGESTIONS: "false", PLATFORM_AUTH_PER_MINUTE_PER_IP: "1000" });
    });
    after(() => srv && srv.stop());

    test("developer accounts: register, login, me, wrong password, isolation from other apps' tokens", async () => {
        const email = `dev${uniq()}@example.com`;
        const weak = await call("POST", `${P}/auth/register`, { json: { email, password: "short", accept_terms: true } });
        assert.equal(weak.status, 422);
        const noTerms = await call("POST", `${P}/auth/register`, { json: { email, password: "Builder2026" } });
        assert.equal(noTerms.status, 422);
        const reg = await call("POST", `${P}/auth/register`, { json: { email, password: "Builder2026", accept_terms: true } });
        assert.equal(reg.status, 201);
        assert.equal((await call("POST", `${P}/auth/register`, { json: { email, password: "Builder2026", accept_terms: true } })).status, 409);
        assert.equal((await call("POST", `${P}/auth/login`, { json: { email, password: "Wrong2026x" } })).status, 401);
        const login = await call("POST", `${P}/auth/login`, { json: { email, password: "Builder2026" } });
        assert.equal(login.status, 200);
        const me = await call("GET", `${P}/auth/me`, { token: login.data.access_token });
        assert.equal(me.data.email, email);
        assert.equal(me.data.passwordHash, undefined);
        // a CropGuard token is not a developer token
        const cg = await call("POST", "/api/v1/cropguard/auth/register", { json: { email: `cg${uniq()}@example.com`, password: "Cassava2026", age_confirmed: true, accept_terms: true } });
        assert.equal((await call("GET", `${P}/auth/me`, { token: cg.data.access_token })).status, 401);
    });

    test("app spec is validated strictly", async () => {
        const t = await devSignup();
        const bad = async (patch, field) => {
            const r = await call("POST", `${P}/apps`, { token: t, json: { ...spec(), ...patch } });
            assert.equal(r.status, 422, JSON.stringify(r.data));
            if (field) assert.ok(r.data.detail.fields.some((f) => f.field.startsWith(field)), JSON.stringify(r.data.detail.fields));
        };
        await bad({ frontend_urls: ["javascript:alert(1)"] }, "frontend_urls[0]");
        await bad({ frontend_urls: ["http://shop.example.com"] }, "frontend_urls[0]"); // http only for localhost
        await bad({ collections: [{ name: "$where", fields: [{ name: "a", type: "string" }] }] }, "collections[0].name");
        await bad({ collections: [{ name: "x", fields: [{ name: "a.b", type: "string" }] }] }, "collections[0].fields[0].name");
        await bad({ collections: [{ name: "x", fields: [{ name: "owner", type: "string" }] }] }, "collections[0].fields[0].name");
        await bad({ collections: [{ name: "x", fields: [{ name: "a", type: "function" }] }] }, "collections[0].fields[0].type");
        await bad({ collections: [{ name: "x", access: { read: "everyone" }, fields: [{ name: "a", type: "string" }] }] }, "collections[0].access.read");
        await bad({ slug: "cropguard" }, "slug");
        const local = await call("POST", `${P}/apps`, { token: t, json: { ...spec(), frontend_urls: ["http://localhost:5173", "https://shop.example.com/some/page"] } });
        assert.equal(local.status, 201);
        assert.deepEqual(local.data.frontend_urls, ["http://localhost:5173", "https://shop.example.com"]);
    });

    test("generated API: keys, origins, access rules, validation and injection", async () => {
        const t = await devSignup();
        const created = await call("POST", `${P}/apps`, { token: t, json: spec() });
        assert.equal(created.status, 201);
        const { slug, publishable_key: key, secret_key: secret } = created.data;
        assert.match(secret, /^sk_[0-9a-f]{64}$/);
        const A = `/api/v1/apps/${slug}`;
        const web = "https://shop.example.com";

        // docs are public and list the routes
        const docs = await call("GET", `${A}/docs`);
        assert.equal(docs.status, 200);
        assert.ok(docs.data.endpoints.some((e) => e.path === `${A}/data/products` && e.method === "POST"));

        // key + origin
        assert.equal((await call("GET", `${A}/data/products`)).status, 401);
        assert.equal((await call("GET", `${A}/data/products`, { key: "pk_wrong" })).status, 401);
        assert.equal((await call("GET", `${A}/data/products`, { key, origin: "https://evil.example" })).status, 403);
        assert.equal((await call("GET", `${A}/data/products`, { key, origin: web })).status, 200);
        assert.equal((await call("GET", `${A}/data/products`, { key, origin: "http://localhost:3000" })).status, 200);
        assert.equal((await call("GET", `${A}/data/products`, { token: secret, origin: web })).status, 403); // secret key in a browser

        // admin-only create via the secret key from a server
        const item = { name: "Cutlass", price: 45, category: "tools" };
        assert.equal((await call("POST", `${A}/data/products`, { key, origin: web, json: item })).status, 403); // only the server
        const p = await call("POST", `${A}/data/products`, { token: secret, json: item });
        assert.equal(p.status, 201);
        assert.equal(p.data.name, "Cutlass");

        // validation: types, unknown fields, operator objects
        const bad = await call("POST", `${A}/data/products`, { token: secret, json: { name: { $gt: "" }, price: "45", extra: 1 } });
        assert.equal(bad.status, 422);
        const fields = bad.data.detail.fields.map((f) => f.field).sort();
        assert.deepEqual(fields, ["extra", "name", "price"]);
        assert.equal((await call("POST", `${A}/data/products`, { token: secret, json: { name: "x", price: 1, category: "cars" } })).status, 422);
        // filters are typed: no operator injection through the query string
        assert.equal((await call("GET", `${A}/data/products?price[$gt]=0`, { key })).status, 422);
        assert.equal((await call("GET", `${A}/data/products?nope=1`, { key })).status, 422);
        const filtered = await call("GET", `${A}/data/products?category=tools&sort=-price`, { key });
        assert.equal(filtered.data.total, 1);

        // end users
        const u1 = await call("POST", `${A}/auth/register`, { key, origin: web, json: { email: `u${uniq()}@example.com`, password: "Farmer2026" } });
        assert.equal(u1.status, 201);
        const u2 = await call("POST", `${A}/auth/register`, { key, origin: web, json: { email: `u${uniq()}@example.com`, password: "Farmer2026" } });
        const t1 = u1.data.access_token;
        const t2 = u2.data.access_token;
        assert.equal((await call("POST", `${A}/data/notes`, { key, json: { body: "hi" } })).status, 401);
        const note = await call("POST", `${A}/data/notes`, { key, token: t1, json: { body: "plant maize", done: false } });
        assert.equal(note.status, 201);
        assert.equal(note.data.owner_id, u1.data.user.id);
        // owners only
        assert.equal((await call("GET", `${A}/data/notes`, { key, token: t2 })).data.total, 0);
        assert.equal((await call("GET", `${A}/data/notes/${note.data.id}`, { key, token: t2 })).status, 404);
        assert.equal((await call("PATCH", `${A}/data/notes/${note.data.id}`, { key, token: t2, json: { done: true } })).status, 404);
        const upd = await call("PATCH", `${A}/data/notes/${note.data.id}`, { key, token: t1, json: { done: true } });
        assert.equal(upd.data.done, true);
        assert.equal(upd.data.body, "plant maize");
        // public contact form: anyone can write, only the server can read
        assert.equal((await call("POST", `${A}/data/messages`, { key, origin: web, json: { email: "A@Example.com", message: "Hello" } })).status, 201);
        assert.equal((await call("GET", `${A}/data/messages`, { key, token: t1 })).status, 403);
        const inbox = await call("GET", `${A}/data/messages`, { token: secret });
        assert.equal(inbox.data.items[0].email, "a@example.com");

        // a user token from this app does not work on another app, or on the developer API
        const other = await call("POST", `${P}/apps`, { token: t, json: { ...spec(), name: `Other ${uniq()}` } });
        assert.equal((await call("GET", `/api/v1/apps/${other.data.slug}/auth/me`, { key: other.data.publishable_key, token: t1 })).status, 401);
        assert.equal((await call("GET", `${P}/apps`, { token: t1 })).status, 401);

        // files: type sniffed from bytes, served from an unguessable link
        const fake = new FormData();
        fake.append("file", new Blob([Buffer.from("<script>alert(1)</script>")], { type: "image/png" }), "x.png");
        assert.equal((await call("POST", `${A}/files`, { key, token: t1, form: fake })).status, 415);
        const img = new FormData();
        img.append("file", new Blob([await solid([10, 200, 30], "png", [64, 64])], { type: "image/png" }), "leaf.png");
        const up = await call("POST", `${A}/files`, { key, token: t1, form: img });
        assert.equal(up.status, 201, JSON.stringify(up.data));
        const got = await fetch(`${srv.origin}${up.data.url}`);
        assert.equal(got.status, 200);
        assert.equal(got.headers.get("content-type"), "image/png");
        assert.match(got.headers.get("content-security-policy"), /sandbox/);
        assert.equal((await call("DELETE", `${A}/files/${up.data.id}`, { key, token: t2 })).status, 404);

        // secret rotation: the old key stops working at once
        const rot = await call("POST", `${P}/apps/${created.data.id}/rotate-secret`, { token: t });
        assert.equal((await call("GET", `${A}/admin/users`, { token: secret })).status, 401);
        const users = await call("GET", `${A}/admin/users`, { token: rot.data.secret_key });
        assert.equal(users.data.total, 2);
        assert.equal(users.data.items[0].passwordHash, undefined);
    });

    test("developers only see their own apps; deleting an app removes its data", async () => {
        const a = await devSignup();
        const b = await devSignup();
        const app = (await call("POST", `${P}/apps`, { token: a, json: spec() })).data;
        assert.equal((await call("GET", `${P}/apps/${app.id}`, { token: b })).status, 404);
        assert.equal((await call("PATCH", `${P}/apps/${app.id}`, { token: b, json: { name: "Mine now" } })).status, 404);
        assert.equal((await call("DELETE", `${P}/apps/${app.id}`, { token: a, json: { confirm: "nope" } })).status, 422);
        assert.equal((await call("DELETE", `${P}/apps/${app.id}`, { token: a, json: { confirm: app.slug } })).status, 204);
        assert.equal((await call("GET", `/api/v1/apps/${app.slug}/docs`)).status, 404);
    });

    test("describe-an-API suggestions recommend built-ins and draft a valid collection", async () => {
        const t = await devSignup();
        const app = (await call("POST", `${P}/apps`, { token: t, json: { ...spec(), collections: [] } })).data;
        const s1 = await call("POST", `${P}/apps/${app.id}/suggest`, { token: t, json: { description: "users should be able to sign up and log in" } });
        assert.equal(s1.status, 200);
        assert.equal(s1.data.collection, null);
        assert.ok(s1.data.recommendations.some((r) => r.feature === "auth"));
        const s2 = await call("POST", `${P}/apps/${app.id}/suggest`, { token: t, json: { description: "a todo list where each user keeps their own tasks, and pay with mobile money" } });
        assert.equal(s2.data.collection.name, "tasks");
        assert.equal(s2.data.collection.access.read, "owner");
        assert.ok(s2.data.recommendations.some((r) => r.kind === "not_supported"));
        // the draft is accepted as-is
        const add = await call("POST", `${P}/apps/${app.id}/collections`, { token: t, json: s2.data.collection });
        assert.equal(add.status, 201, JSON.stringify(add.data));
        assert.deepEqual(add.data.collections.map((c) => c.name), ["tasks"]);
        const again = await call("POST", `${P}/apps/${app.id}/suggest`, { token: t, json: { description: "more tasks for people" } });
        assert.ok(again.data.recommendations.some((r) => r.kind === "existing" && r.collection === "tasks"));
        assert.notEqual(again.data.collection.name, "tasks");
    });

    test("existing apps are unaffected", async () => {
        assert.equal((await call("GET", "/api/v1/cropguard/health")).status, 200);
        const cb = await call("POST", "/api/v1/cleanbridge/auth/login", { json: {} });
        assert.ok(cb.data && typeof cb.data.msg === "string");
    });
});
