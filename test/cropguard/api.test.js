// GhanaCropGuard API tests against the real server. See helpers.js for setup.
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { MONGO, client, mongoProblem, solid, startServer } = require("./helpers.js");

const skip = mongoProblem() || false; // node:test treats `skip: null` as skipped

describe("cropguard API", { skip }, () => {
    let srv;
    let api;
    let adminToken;

    before(async () => {
        srv = await startServer();
        api = client(srv);
        const r = await api.call("POST", "/auth/login", { json: { email: "admin@example.com", password: "AdminPass123" } });
        adminToken = r.data.access_token;
    });
    after(() => srv && srv.stop());

    test("health reports model and database", async () => {
        const r = await api.call("GET", "/health");
        assert.equal(r.status, 200);
        assert.equal(r.data.status, "ok");
        assert.equal(r.data.model_version, "tiny-test-0.0.1");
    });

    test("security headers and unknown routes stay in the namespace", async () => {
        const r = await api.call("GET", "/health");
        assert.equal(r.headers.get("x-content-type-options"), "nosniff");
        const nf = await api.call("GET", "/nope");
        assert.equal(nf.status, 404);
        assert.equal(nf.data.detail.code, "error");
    });

    test("model info, crops catalogue and policy", async () => {
        const m = await api.call("GET", "/model/info");
        assert.equal(m.status, 200);
        assert.equal(m.data.num_classes, 22);
        const c = await api.call("GET", "/crops");
        assert.deepEqual(Object.keys(c.data.crops).sort(), ["cashew", "cassava", "maize", "tomato"]);
        assert.equal(c.data.regions.length, 16);
        assert.ok(c.data.crops.maize.some((x) => x.class_key === "maize_fall_armyworm" && x.summary));
        const p = await api.call("GET", "/policy");
        assert.equal(p.data.min_age, 16);
    });

    test("register, login and me", async () => {
        const reg = await api.register({ region: "Ashanti" });
        assert.equal(reg.token_type, "bearer");
        assert.ok(reg.expires_in > 0);
        assert.equal(reg.user.region, "Ashanti");
        assert.equal(reg.user.password, undefined);
        assert.equal(reg.user.passwordHash, undefined);
        const dup = await api.call("POST", "/auth/register", {
            json: { email: reg.email.toUpperCase(), password: "Cassava2026", age_confirmed: true, accept_terms: true },
        });
        assert.equal(dup.status, 409);
        assert.equal(dup.data.detail.code, "email_taken");
        const login = await api.call("POST", "/auth/login", { json: { email: reg.email, password: "Cassava2026" } });
        assert.equal(login.status, 200);
        const me = await api.call("GET", "/auth/me", { token: login.data.access_token });
        assert.equal(me.data.email, reg.email);
        const bad = await api.call("POST", "/auth/login", { json: { email: reg.email, password: "Wrong12345" } });
        assert.equal(bad.status, 401);
        assert.equal(bad.data.detail.code, "invalid_credentials");
        const ghost = await api.call("POST", "/auth/login", { json: { email: "ghost@example.com", password: "Wrong12345" } });
        assert.equal(ghost.status, 401);
        assert.equal(ghost.data.detail.message, bad.data.detail.message);
    });

    test("weak password, bad region and missing consent are rejected with field errors", async () => {
        const base = { email: "young@example.com", age_confirmed: true, accept_terms: true };
        let r = await api.call("POST", "/auth/register", { json: { ...base, password: "short1" } });
        assert.equal(r.status, 422);
        assert.equal(r.data.detail.fields[0].field, "password");
        r = await api.call("POST", "/auth/register", { json: { ...base, password: "lettersonly" } });
        assert.match(r.data.detail.message, /letters and numbers/);
        r = await api.call("POST", "/auth/register", { json: { ...base, password: "Maize2026x", region: "Narnia" } });
        assert.equal(r.data.detail.fields[0].field, "region");
        r = await api.call("POST", "/auth/register", { json: { email: "young@example.com", password: "Maize2026x" } });
        assert.equal(r.status, 422);
        r = await api.call("POST", "/auth/register", { json: { ...base, password: "Maize2026x", age_confirmed: false } });
        assert.match(r.data.detail.message, /minimum age/);
        r = await api.call("POST", "/auth/register", { json: { ...base, password: "Maize2026x", accept_terms: false } });
        assert.match(r.data.detail.message, /Terms/);
    });

    test("operator injection in JSON is a validation error, not a query", async () => {
        const r = await api.call("POST", "/auth/login", { json: { email: { $ne: null }, password: { $ne: null } } });
        assert.equal(r.status, 422);
        const reg = await api.register();
        const h = await api.call("GET", "/predictions/history?crop[$ne]=x", { token: reg.access_token });
        assert.equal(h.status, 422);
        const broken = await api.call("POST", "/auth/login", { headers: { "Content-Type": "application/json" }, form: "{not json" });
        assert.equal(broken.status, 422);
    });

    test("requires auth and rejects other apps' and tampered tokens", async () => {
        assert.equal((await api.call("GET", "/auth/me")).status, 401);
        assert.equal((await api.call("GET", "/auth/me", { token: "garbage" })).status, 401);
        const jwt = require("jsonwebtoken");
        const reg = await api.register();
        // same secret, but a CleanBridge-style token: no app claim
        const foreign = jwt.sign({ sub: reg.user.id, userId: reg.user.id, tv: 0, type: "access" }, "cropguard-test-secret-that-is-long-enough");
        const r = await api.call("GET", "/auth/me", { token: foreign });
        assert.equal(r.status, 401);
        assert.equal(r.headers.get("www-authenticate"), "Bearer");
        const forged = jwt.sign({ sub: reg.user.id, tv: 0, type: "access", app: "cropguard" }, "some-other-secret");
        assert.equal((await api.call("GET", "/auth/me", { token: forged })).status, 401);
    });

    test("password change and logout-all revoke old tokens", async () => {
        const reg = await api.register();
        const wrong = await api.call("POST", "/auth/me/password", {
            token: reg.access_token, json: { current_password: "nope12345", new_password: "Newpass2026" },
        });
        assert.equal(wrong.status, 400); // 400, not 401: the clients treat 401 as "signed out"
        const ok = await api.call("POST", "/auth/me/password", {
            token: reg.access_token, json: { current_password: "Cassava2026", new_password: "Newpass2026" },
        });
        assert.equal(ok.status, 204);
        assert.equal((await api.call("GET", "/auth/me", { token: reg.access_token })).status, 401);
        const login = await api.call("POST", "/auth/login", { json: { email: reg.email, password: "Newpass2026" } });
        assert.equal(login.status, 200);
        assert.equal((await api.call("POST", "/auth/logout-all", { token: login.data.access_token })).status, 204);
        assert.equal((await api.call("GET", "/auth/me", { token: login.data.access_token })).status, 401);
    });

    test("forgot and reset password", async () => {
        const reg = await api.register();
        const generic = "If an account exists for that email, we have sent a link to reset the password.";
        const unknown = await api.call("POST", "/auth/forgot-password", { json: { email: "nobody-here@example.com" } });
        assert.equal(unknown.status, 200);
        assert.equal(unknown.data.message, generic); // no account enumeration
        const evil = await api.call("POST", "/auth/forgot-password", {
            json: { email: reg.email, redirect_uri: "https://evil.example/steal" },
        });
        assert.equal(evil.status, 400);
        assert.equal(evil.data.detail.code, "redirect_not_allowed");
        const sent = await api.call("POST", "/auth/forgot-password", { json: { email: reg.email } });
        assert.equal(sent.status, 200);
        assert.equal(sent.data.message, generic);

        // The emailed token is never stored; plant a known one to play the emailed link.
        const db = await mongoose.createConnection(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
        const users = db.collection("cropguardusers");
        const stored = await users.findOne({ email: reg.email });
        assert.match(stored.resetTokenHash, /^[0-9a-f]{64}$/);
        const token = crypto.randomBytes(32).toString("hex");
        const hash = crypto.createHash("sha256").update(token).digest("hex");
        await users.updateOne({ email: reg.email }, { $set: { resetTokenHash: hash } });

        const reset = (json) => api.call("POST", "/auth/reset-password", { json: { email: reg.email, ...json } });
        assert.equal((await reset({ token: "ab".repeat(32), new_password: "Fresh2026pw" })).status, 400);
        assert.equal((await reset({ token, new_password: "short" })).status, 422);
        assert.equal((await reset({ token, new_password: "Fresh2026pw" })).status, 200);
        assert.equal((await reset({ token, new_password: "Again2026pw" })).status, 400); // single use
        assert.equal((await api.call("GET", "/auth/me", { token: reg.access_token })).status, 401); // sessions revoked
        assert.equal((await api.call("POST", "/auth/login", { json: { email: reg.email, password: "Cassava2026" } })).status, 401);
        assert.equal((await api.call("POST", "/auth/login", { json: { email: reg.email, password: "Fresh2026pw" } })).status, 200);

        // An expired token is refused too.
        await users.updateOne({ email: reg.email }, {
            $set: { resetTokenHash: hash, resetTokenExpires: new Date(Date.now() - 1000) },
        });
        assert.equal((await reset({ token, new_password: "Later2026pw" })).status, 400);
        await db.close();
    });

    test("Google sign-in only redirects to allowed sites", async () => {
        const start = (redirect, extra = "") => fetch(
            `${srv.origin}/api/v1/auth/google?app=cropguard${extra}&redirect_uri=${encodeURIComponent(redirect)}`,
            { redirect: "manual" },
        );
        const bad = await start("https://evil.example/cb");
        assert.equal(bad.status, 400);
        assert.equal((await bad.json()).detail.code, "redirect_not_allowed");
        if (!process.env.GOOGLE_CLIENT_ID) return; // the strategy needs a client id to build the Google URL
        const good = await start("https://cropguard-web.example.com/auth/google", "&consent=1");
        assert.equal(good.status, 302);
        const state = new URL(good.headers.get("location")).searchParams.get("state");
        assert.equal(state.split(".").length, 3); // a signed JWT, not editable JSON
    });

    test("profile update", async () => {
        const reg = await api.register();
        const r = await api.call("PATCH", "/auth/me", { token: reg.access_token, json: { full_name: "Kofi", region: "Volta" } });
        assert.equal(r.data.full_name, "Kofi");
        assert.equal(r.data.region, "Volta");
        const cleared = await api.call("PATCH", "/auth/me", { token: reg.access_token, json: { full_name: null } });
        assert.equal(cleared.data.full_name, null);
        const bad = await api.call("PATCH", "/auth/me", { token: reg.access_token, json: { preferred_language: "xx" } });
        assert.equal(bad.status, 422);
    });

    test("prediction runs the real ONNX model and persists", async () => {
        const reg = await api.register();
        const r = await api.upload(reg.access_token, await solid([10, 230, 10]));
        assert.equal(r.status, 201, r.text);
        const j = r.data;
        assert.equal(j.predicted.class_key, "cassava_mosaic");
        assert.equal(j.crop, "cassava");
        assert.equal(j.top_predictions.length, 3);
        assert.ok(j.predicted.confidence > 0 && j.predicted.confidence <= 1);
        assert.equal(j.model_version, "tiny-test-0.0.1");
        assert.ok(j.processing_ms > 0);
        assert.ok(j.explanation && j.next_steps.length && j.escalate.includes("extension officer"));
        assert.ok(j.warnings.some((w) => w.code === "scope"));
        assert.match(j.disclaimer, /not a diagnosis/);
        assert.match(j.image_url, /^\/api\/v1\/cropguard\/predictions\/[0-9a-f]{24}\/image\?sig=/);
        const img = await fetch(srv.origin + j.image_url);
        assert.equal(img.status, 200);
        assert.equal(img.headers.get("content-type"), "image/jpeg");
        const bytes = Buffer.from(await img.arrayBuffer());
        const meta = await require("sharp")(bytes).metadata();
        assert.equal(meta.format, "jpeg");
        assert.equal(meta.exif, undefined);
        const g = await api.call("GET", `/predictions/${j.id}`, { token: reg.access_token });
        assert.equal(g.data.predicted.class_key, "cassava_mosaic");
    });

    test("different input gives a different class; ambiguous input warns", async () => {
        const reg = await api.register();
        const red = await api.upload(reg.access_token, await solid([240, 10, 10]));
        assert.equal(red.data.predicted.class_key, "cashew_red_rust");
        const flat = await api.upload(reg.access_token, await solid([124, 116, 104]));
        assert.ok(flat.data.warnings.some((w) => w.code === "low_confidence"));
    });

    test("PNG and WebP accepted; bad uploads rejected", async () => {
        const reg = await api.register();
        const t = reg.access_token;
        assert.equal((await api.upload(t, await solid([10, 230, 10], "png"), "a.png", "image/png")).status, 201);
        assert.equal((await api.upload(t, await solid([10, 230, 10], "webp"), "a.webp", "image/webp")).status, 201);
        assert.equal((await api.upload(t, Buffer.from("hello world"), "x.txt", "text/plain")).status, 415);
        let r = await api.upload(t, Buffer.from("hello world not an image"), "x.jpg", "image/jpeg");
        assert.equal(r.status, 400);
        assert.equal(r.data.detail.code, "invalid_image");
        r = await api.upload(t, (await solid([10, 230, 10])).subarray(0, 300));
        assert.equal(r.status, 400);
        assert.equal(r.data.detail.code, "invalid_image");
        r = await api.upload(t, Buffer.alloc(0));
        assert.equal(r.status, 400);
        const none = await api.call("POST", "/predictions", { token: t, form: new FormData() });
        assert.equal(none.status, 422);
        assert.equal(none.data.detail.fields[0].field, "image");
    });

    test("unauthenticated uploads are refused before the body is read", async () => {
        const r = await api.upload(undefined, await solid([10, 230, 10]));
        assert.equal(r.status, 401);
    });

    test("history search, filter, patch and delete", async () => {
        const reg = await api.register();
        const t = reg.access_token;
        const a = (await api.upload(t, await solid([10, 230, 10]))).data;
        const b = (await api.upload(t, await solid([240, 10, 10]))).data;
        let h = (await api.call("GET", "/predictions/history", { token: t })).data;
        assert.equal(h.total, 2);
        assert.equal(h.items[0].id, b.id); // newest first
        const total = async (qs) => (await api.call("GET", `/predictions/history?${qs}`, { token: t })).data.total;
        assert.equal(await total("crop=cassava"), 1);
        assert.equal(await total("q=mosaic"), 1);
        assert.equal(await total("q=rust"), 1);
        const p = await api.call("PATCH", `/predictions/${a.id}`, { token: t, json: { saved: true, note: "Field near the river" } });
        assert.equal(p.data.saved, true);
        assert.equal(p.data.note, "Field near the river");
        assert.equal(await total("saved=true"), 1);
        assert.equal(await total("q=river"), 1);
        assert.equal(await total("q=" + encodeURIComponent("(.*")), 0); // regex characters are escaped
        assert.equal((await api.call("GET", "/predictions/history?page_size=500", { token: t })).status, 422);
        assert.equal((await api.call("DELETE", `/predictions/${a.id}`, { token: t })).status, 204);
        assert.equal((await api.call("GET", `/predictions/${a.id}`, { token: t })).status, 404);
        assert.equal((await api.call("DELETE", "/predictions", { token: t })).status, 204);
        h = (await api.call("GET", "/predictions/history", { token: t })).data;
        assert.equal(h.total, 0);
    });

    test("users cannot access each other's records", async () => {
        const owner = await api.register();
        const mine = (await api.upload(owner.access_token, await solid([10, 230, 10]))).data;
        const other = (await api.register()).access_token;
        assert.equal((await api.call("GET", `/predictions/${mine.id}`, { token: other })).status, 404);
        assert.equal((await api.call("DELETE", `/predictions/${mine.id}`, { token: other })).status, 404);
        assert.equal((await api.call("PATCH", `/predictions/${mine.id}`, { token: other, json: { saved: true } })).status, 404);
        assert.equal((await api.call("GET", "/predictions/history", { token: other })).data.total, 0);
        assert.equal((await api.call("GET", "/predictions/not-an-id", { token: other })).status, 404);
        const sig = mine.image_url.split("sig=")[1];
        assert.equal((await api.call("GET", `/predictions/${"0".repeat(24)}/image?sig=${sig}`)).status, 403);
        assert.equal((await api.call("GET", `/predictions/${mine.id}/image?sig=bad`)).status, 403);
    });

    test("account deletion removes the data", async () => {
        const reg = await api.register();
        const p = (await api.upload(reg.access_token, await solid([10, 230, 10]))).data;
        const wrong = await api.call("DELETE", "/auth/me", { token: reg.access_token, json: { password: "Wrong12345" } });
        assert.equal(wrong.status, 400);
        const r = await api.call("DELETE", "/auth/me", { token: reg.access_token, json: { password: "Cassava2026" } });
        assert.equal(r.status, 204);
        assert.equal((await fetch(srv.origin + p.image_url)).status, 404);
        assert.equal((await api.call("GET", "/auth/me", { token: reg.access_token })).status, 401);
    });

    test("statistics are admin only and count real requests", async () => {
        const reg = await api.register();
        assert.equal((await api.call("GET", "/statistics", { token: reg.access_token })).status, 403);
        await api.upload(reg.access_token, await solid([10, 230, 10]));
        await api.upload(reg.access_token, Buffer.from("garbage-bytes"), "x.jpg");
        const s = await api.call("GET", "/statistics", { token: adminToken });
        assert.equal(s.status, 200);
        const live = s.data.live;
        assert.ok(live.successful_predictions >= 1 && live.failed_requests >= 1);
        assert.ok((live.failed_by_reason.invalid_image || 0) >= 1);
        assert.ok((live.crop_distribution.cassava || 0) >= 1);
        assert.ok(live.volume_by_day.length && live.average_processing_ms > 0);
        assert.equal(s.data.model.current_version, "tiny-test-0.0.1");
        assert.match(s.data.note, /correctness of live predictions is unknown/);
    });

    test("admin user management, audit log and model versions", async () => {
        const victim = await api.register();
        const r = await api.call("PATCH", `/admin/users/${victim.user.id}`, { token: adminToken, json: { is_active: false } });
        assert.equal(r.status, 200);
        assert.equal(r.data.is_active, false);
        assert.equal((await api.call("GET", "/auth/me", { token: victim.access_token })).status, 401);
        const relogin = await api.call("POST", "/auth/login", { json: { email: victim.email, password: "Cassava2026" } });
        assert.equal(relogin.status, 401);
        const me = (await api.call("GET", "/auth/me", { token: adminToken })).data;
        assert.equal((await api.call("PATCH", `/admin/users/${me.id}`, { token: adminToken, json: { role: "user" } })).status, 400);
        const users = await api.call("GET", "/admin/users?page_size=5", { token: adminToken });
        assert.ok(users.data.total >= 1 && users.data.items.length <= 5);
        const log = (await api.call("GET", "/admin/audit", { token: adminToken })).data;
        assert.ok(log.some((e) => e.action === "admin.user_update"));
        const models = (await api.call("GET", "/admin/models", { token: adminToken })).data;
        assert.ok(models[0].is_active);
        assert.equal(models[0].name, "tiny-test-0.0.1");
        assert.equal((await api.call("GET", "/admin/users", { token: victim.access_token })).status, 401);
        const plain = await api.register();
        assert.equal((await api.call("GET", "/admin/users", { token: plain.access_token })).status, 403);
    });

    test("other apps on the server still answer as before", async () => {
        const r = await api.call("GET", "/api/v1/cleanbridge/auth/me");
        assert.equal(r.status, 401);
        assert.ok("msg" in r.data); // the shared { msg } error shape is untouched
        const docs = await fetch(`${srv.origin}/api-docs.json`);
        assert.equal(docs.status, 200);
        const paths = Object.keys((await docs.json()).paths);
        assert.ok(paths.some((p) => p.startsWith("/api/v1/cropguard/")));
        assert.ok(paths.some((p) => p.startsWith("/api/v1/cleanbridge/")));
    });
});

describe("cropguard API with tight limits and no model", { skip }, () => {
    let srv;
    let api;
    before(async () => {
        srv = await startServer({
            CROPGUARD_MODEL_DIR: "test/cropguard/does-not-exist",
            CROPGUARD_RATE_LIMIT_PREDICTIONS_PER_MINUTE: "2",
            CROPGUARD_MAX_UPLOAD_MB: "0.05",
            CROPGUARD_BOOTSTRAP_ADMIN_EMAIL: "",
        });
        api = client(srv);
    });
    after(() => srv && srv.stop());

    test("model unavailable returns 503, never a fake prediction", async () => {
        const reg = await api.register();
        const r = await api.upload(reg.access_token, await solid([10, 230, 10], "jpeg", [64, 64]));
        assert.equal(r.status, 503);
        assert.equal(r.data.detail.code, "model_unavailable");
        assert.equal((await api.call("GET", "/health")).data.status, "degraded");
        assert.equal((await api.call("GET", "/model/info")).status, 503);
    });

    test("oversized upload is rejected with 413", async () => {
        const reg = await api.register();
        const big = Buffer.concat([await solid([10, 230, 10]), Buffer.alloc(200000)]);
        const r = await api.upload(reg.access_token, big);
        assert.equal(r.status, 413);
        assert.equal(r.data.detail.code, "file_too_large");
    });

    test("prediction rate limit", async () => {
        const reg = await api.register();
        const img = await solid([10, 230, 10], "jpeg", [64, 64]);
        await api.upload(reg.access_token, img);
        await api.upload(reg.access_token, img);
        const r = await api.upload(reg.access_token, img);
        assert.equal(r.status, 429);
        assert.equal(r.data.detail.code, "rate_limited");
        assert.ok(r.headers.get("retry-after"));
    });
});
