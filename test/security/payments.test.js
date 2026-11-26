// Payment failure paths (production-ready-app skill, section F) for the CODM Paystack webhook,
// on a THROWAWAY database (see test/cropguard/helpers.js). No call reaches Paystack: the tests
// sign webhooks with a fake CODM_PAYSTACK_SECRET_KEY exactly as Paystack would.
//   CROPGUARD_TEST_MONGO_URI=mongodb://127.0.0.1:27017/security_test npm run test:security
const { test, describe, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const mongoose = require("mongoose");
const { MONGO, mongoProblem, startServer } = require("../cropguard/helpers.js");

const skip = mongoProblem() || false;
const KEY = "sk_test_fake_key_for_webhook_tests";
const AMOUNT = 5100; // pesewas charged for this test checkout
let n = 0;
const uniq = () => `${Date.now()}${(n += 1)}`;

describe("payment failure paths: CODM Paystack webhook", { skip }, () => {
    let srv;
    let db;

    const send = async (event, { key = KEY } = {}) => {
        const body = JSON.stringify(event);
        const sig = crypto.createHmac("sha512", key).update(body).digest("hex");
        const r = await fetch(`${srv.origin}/api/v1/codm/payments/webhook`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "x-paystack-signature": sig },
            body,
        });
        return r.status;
    };
    // A player with one pending checkout, inserted straight into the test database.
    const checkout = async (extra = {}) => {
        const id = uniq();
        const player = await db.collection("codmplayers").insertOne({
            fullName: "Kofi", email: `p${id}@example.com`, phone: `+23324${id.slice(-7)}`, passwordHash: "x", ign: `ign${id.slice(-6)}`,
            codmUid: id, role: "player", teamId: null, paid: false, paidAt: null, paymentReference: null, tokenVersion: 0, isActive: true,
        });
        const playerId = String(player.insertedId);
        const reference = `codm_${playerId}_${id}`;
        await db.collection("codmpayments").insertOne({ reference, playerId: player.insertedId, amountPesewas: AMOUNT, entryPesewas: 5000, currency: "GHS", status: "pending", refundStatus: null, ...extra });
        return { playerId, reference };
    };
    const charge = (reference, playerId, over = {}) => ({
        event: "charge.success",
        data: { status: "success", reference, amount: AMOUNT, currency: "GHS", channel: "mobile_money", domain: "test", metadata: { app: "codm", playerId }, authorization: { bank: "MTN" }, ...over },
    });
    const player = (id) => db.collection("codmplayers").findOne({ _id: new mongoose.Types.ObjectId(id) });

    before(async () => {
        srv = await startServer({ CODM_PAYSTACK_SECRET_KEY: KEY });
        await mongoose.connect(MONGO, { useNewUrlParser: true, useUnifiedTopology: true });
        db = mongoose.connection.db;
    });
    after(async () => {
        await mongoose.disconnect();
        await srv?.stop();
    });

    test("a correctly signed, matching charge marks the player paid", async () => {
        const { playerId, reference } = await checkout();
        assert.equal(await send(charge(reference, playerId)), 200);
        const p = await player(playerId);
        assert.equal(p.paid, true);
        assert.equal(p.paymentReference, reference);
        assert.equal(p.paymentChannel, "MTN MoMo");
    });

    test("unsigned or wrongly signed webhooks change nothing", async () => {
        const { playerId, reference } = await checkout();
        assert.equal(await send(charge(reference, playerId), { key: "sk_test_attacker" }), 401);
        const r = await fetch(`${srv.origin}/api/v1/codm/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(charge(reference, playerId)) });
        assert.equal(r.status, 401);
        assert.equal((await player(playerId)).paid, false);
    });

    test("declined, wrong amount, wrong currency, wrong player or other app: not paid", async () => {
        const cases = [
            { status: "failed" },
            { amount: AMOUNT - 100 },
            { currency: "USD" },
            { metadata: { app: "codm", playerId: new mongoose.Types.ObjectId().toString() } },
            { metadata: { app: "seedbridge" } },
        ];
        for (const over of cases) {
            const { playerId, reference } = await checkout();
            assert.equal(await send(charge(reference, playerId, over)), 200);
            assert.equal((await player(playerId)).paid, false, `paid on ${JSON.stringify(over)}`);
        }
    });

    test("a duplicate or late webhook is idempotent", async () => {
        const { playerId, reference } = await checkout();
        await send(charge(reference, playerId));
        const first = await player(playerId);
        await send(charge(reference, playerId, { paid_at: new Date(Date.now() + 3600e3).toISOString() }));
        await send(charge(reference, playerId));
        const again = await player(playerId);
        assert.equal(again.paid, true);
        assert.equal(String(again.paidAt), String(first.paidAt), "a replay must not move the payment date");
        assert.equal(await db.collection("codmpayments").countDocuments({ reference, status: "success" }), 1);
    });

    test("paying twice keeps the first payment as the player's reference", async () => {
        const { playerId, reference } = await checkout();
        await send(charge(reference, playerId));
        const second = `codm_${playerId}_${uniq()}`;
        await db.collection("codmpayments").insertOne({ reference: second, playerId: new mongoose.Types.ObjectId(playerId), amountPesewas: AMOUNT, currency: "GHS", status: "pending", refundStatus: null });
        await send(charge(second, playerId));
        assert.equal((await player(playerId)).paymentReference, reference);
    });

    test("a refunded checkout never makes the player paid again", async () => {
        const { playerId, reference } = await checkout({ refundStatus: "processed" });
        await send(charge(reference, playerId));
        assert.equal((await player(playerId)).paid, false);
    });

    test("a webhook for an unknown reference is acknowledged and ignored", async () => {
        const id = new mongoose.Types.ObjectId().toString();
        assert.equal(await send(charge(`codm_${id}_123`, id)), 200);
        assert.equal(await db.collection("codmplayers").countDocuments({ _id: new mongoose.Types.ObjectId(id) }), 0);
    });

    test("malformed JSON with a valid signature is a 400, and the server stays up", async () => {
        const body = "{not json";
        const sig = crypto.createHmac("sha512", KEY).update(body).digest("hex");
        const r = await fetch(`${srv.origin}/api/v1/codm/payments/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "x-paystack-signature": sig }, body });
        assert.equal(r.status, 400);
        assert.equal((await fetch(`${srv.origin}/healthz`)).status, 200);
    });
});
