const crypto = require("crypto");
const axios = require("axios");
const { StatusCodes } = require("http-status-codes");
const CodmPlayer = require("../models/CodmPlayer.js");
const CodmPayment = require("../models/CodmPayment.js");
const { BadRequestError, NotFoundError } = require("../errors");
const CodmEventState = require("../models/CodmEventState.js");
const isCancelled = () => CodmEventState.exists({ _id: "main", cancelledAt: { $ne: null } });
const { eventConfig, registrationOpen, pesewas, isAllowedCodmRedirect, toPlayerDTO } = require("../utils/codm.js");

// Entry fee via Paystack hosted checkout (MoMo + card, GHS). Same rules as the
// CleanBridge/SeedBridge payments: the server sets the amount, the caller's
// callbackUrl must be one of our sites, and a player is only marked paid after
// Paystack confirms amount, currency and player (verify call or signed webhook).
//
// CODM_PAYSTACK_SECRET_KEY lets this event use its own key (test while testing,
// live for the real event) without touching the other apps' Paystack settings.
// In production only CODM_PAYSTACK_SECRET_KEY or the live PAYSTACK_SECRET_KEY are used, never
// the shared TEST key, and only charges Paystack marks "live" count (CODM_ALLOW_TEST_PAYMENTS=true
// switches that off for a staging server). Locally the test key is fine.
const isProd = () => process.env.NODE_ENV === "production";
const secretKey = () => process.env.CODM_PAYSTACK_SECRET_KEY
    || (isProd() ? process.env.PAYSTACK_SECRET_KEY : process.env.TEST_PAYSTACK_SECRET_KEY || process.env.PAYSTACK_SECRET_KEY);
const requireLive = () => isProd() && process.env.CODM_ALLOW_TEST_PAYMENTS !== "true";
const paystack = () => axios.create({
    baseURL: "https://api.paystack.co",
    timeout: 15000,
    headers: { Authorization: `Bearer ${secretKey()}`, "Content-Type": "application/json" },
});

const describeChannel = (data) => {
    const auth = data.authorization || {};
    if (data.channel === "mobile_money") return `${auth.bank || "Mobile"} MoMo`.replace(/^Vodafone/i, "Telecel");
    if (data.channel === "card") return `${(auth.card_type || "Card").trim()} card${auth.last4 ? ` •••• ${auth.last4}` : ""}`;
    return data.channel || "Online";
};

// Marks the payment and player as paid if, and only if, Paystack's data matches
// what we charged. Safe to call many times (verify + webhook both call it).
const applySuccessfulCharge = async (data) => {
    if (!data || data.status !== "success" || data.currency !== "GHS") return null;
    if (requireLive() && data.domain !== "live") {
        console.warn(`[codm] ignoring non-live (test) charge ${data.reference} on the production server`);
        return null;
    }
    const payment = await CodmPayment.findOne({ reference: String(data.reference || "") });
    if (!payment) return null;
    // A refunded checkout must never make the player paid again (e.g. they reopen the return page).
    if (payment.refundStatus) return null;
    // amount is what the player paid. If Paystack's dashboard "customer pays the fee"
    // option were ever switched on, Paystack adds its fee and keeps our figure in
    // requested_amount, so accept that too.
    const amountOk = data.amount === payment.amountPesewas || data.requested_amount === payment.amountPesewas;
    if (!amountOk || data.metadata?.playerId !== String(payment.playerId) || data.metadata?.app !== "codm") {
        console.warn(`[codm] payment ${payment.reference} did not match (amount/player); not marking paid`);
        return null;
    }
    const channel = describeChannel(data);
    const already = await CodmPlayer.findOne({ _id: payment.playerId, paid: true, paymentReference: { $ne: payment.reference } }).select("paymentReference").lean();
    if (already) console.warn(`[codm] REFUND NEEDED? player ${payment.playerId} paid again (${payment.reference}); first payment ${already.paymentReference}`);
    const paidAt = new Date(data.paid_at || Date.now());
    await CodmPayment.updateOne({ _id: payment._id, status: { $ne: "success" } }, { status: "success", channel, paidAt });
    await CodmPlayer.updateOne(
        { _id: payment.playerId, paid: false },
        { paid: true, paidAt, paymentReference: payment.reference, paymentChannel: channel }
    );
    require("../utils/codm.js").clearPublicCache();
    return CodmPlayer.findById(payment.playerId);
};

// POST /api/v1/codm/payments/initialize  { callbackUrl }
const initializePayment = async (req, res) => {
    const { callbackUrl } = req.body || {};
    if (typeof callbackUrl !== "string" || !isAllowedCodmRedirect(callbackUrl)) {
        throw new BadRequestError("This site is not allowed to take payments. Set CODM_CLIENT_URL on the server.");
    }
    if (!secretKey()) throw new BadRequestError("Online payment is not set up yet. Contact the organiser.");
    if (!registrationOpen()) throw new BadRequestError("Registration is closed.");
    if (await isCancelled()) throw new BadRequestError("The tournament has been cancelled, so payments are closed.");
    const player = req.player;
    if (player.paid) throw new BadRequestError("You have already paid. See you on match day!");

    const cfg = eventConfig();
    const amount = cfg.totalChargePesewas; // entry fee + Paystack fee (see feeBreakdown in utils/codm.js)
    const reference = `codm_${player._id}_${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
    await CodmPayment.create({ reference, playerId: player._id, amountPesewas: amount, entryPesewas: Math.round(cfg.entryFeeGhs * 100) });

    let response;
    try {
        response = await paystack().post("/transaction/initialize", {
            email: player.email,
            amount,
            currency: "GHS",
            reference,
            callback_url: callbackUrl,
            channels: ["mobile_money", "card"],
            metadata: {
                app: "codm",
                playerId: String(player._id),
                custom_fields: [
                    { display_name: "Event", variable_name: "event", value: cfg.name },
                    { display_name: "Player", variable_name: "player", value: `${player.ign} (${player.codmUid})` },
                    { display_name: "Breakdown", variable_name: "breakdown", value: `Entry GH₵${cfg.entryFeeGhs.toFixed(2)} + Paystack fee GH₵${cfg.processingFeeGhs.toFixed(2)}` },
                ],
            },
        });
    } catch (err) {
        await CodmPayment.updateOne({ reference }, { status: "failed" });
        console.error("[codm] paystack initialize failed:", err.response?.data?.message || err.message);
        throw new BadRequestError("Could not start the payment. Please try again in a minute.");
    }
    res.status(StatusCodes.OK).json({ authorizationUrl: response.data.data.authorization_url, reference });
};

// GET /api/v1/codm/payments/verify/:reference  (after Paystack sends the player back)
const verifyPayment = async (req, res) => {
    const reference = String(req.params.reference || "");
    if (!/^codm_[a-f0-9]{24}_\d{10,16}[a-f0-9]{0,6}$/.test(reference)) throw new BadRequestError("Invalid payment reference");
    const payment = await CodmPayment.findOne({ reference });
    if (!payment || String(payment.playerId) !== String(req.player._id)) throw new NotFoundError("Payment not found");

    if (payment.status !== "success") {
        let data;
        try {
            ({ data: { data } } = await paystack().get(`/transaction/verify/${encodeURIComponent(reference)}`));
        } catch (err) {
            console.error("[codm] paystack verify failed:", err.response?.data?.message || err.message);
            throw new BadRequestError("Could not confirm the payment yet. Refresh in a minute.");
        }
        await applySuccessfulCharge(data);
        if (data.status === "failed" || data.status === "abandoned") {
            await CodmPayment.updateOne({ _id: payment._id, status: "pending" }, { status: "failed" });
        }
    }
    const player = await CodmPlayer.findById(req.player._id);
    res.status(StatusCodes.OK).json({ success: player.paid, player: toPlayerDTO(player) });
};

// POST /api/v1/codm/payments/webhook  (Paystack -> us; raw body, HMAC-SHA512)
// Set the webhook URL on Paystack: https://<backend>/api/v1/codm/payments/webhook
// One Paystack account has one webhook URL; events for other apps are ignored here.
const webhook = async (req, res) => {
    const key = secretKey();
    const signature = req.headers["x-paystack-signature"];
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
    if (!key || typeof signature !== "string") return res.sendStatus(StatusCodes.UNAUTHORIZED);
    const expected = crypto.createHmac("sha512", key).update(raw).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(signature);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.sendStatus(StatusCodes.UNAUTHORIZED);

    let event;
    try {
        event = JSON.parse(raw.toString("utf8"));
    } catch {
        return res.sendStatus(StatusCodes.BAD_REQUEST);
    }
    if (event.event === "charge.success" && event.data?.metadata?.app === "codm") {
        await applySuccessfulCharge(event.data);
    }
    res.sendStatus(StatusCodes.OK);
};

// ---------------------------------------------------------------------------
// Catching payments the return page missed.
//
// The return page is not enough on its own: a MoMo approval can take minutes, and
// a player may close Paystack's page or lose network before coming back. Without a
// webhook nothing would ever look at that payment again, so the player paid but
// stays "unpaid". These look again at recent checkouts that are not marked
// success yet (pending, or failed because Paystack said "abandoned" at the time):
//  - for one player, when their dashboard loads (POST /payments/sync)
//  - for everyone, every 5 minutes in the background and from the admin page.
// applySuccessfulCharge does all the checks, so asking twice is harmless.
const SYNC_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

const recheck = async (payment) => {
    try {
        const { data } = await paystack().get(`/transaction/verify/${encodeURIComponent(payment.reference)}`);
        const tx = data.data || {};
        if (tx.status === "success") return !!(await applySuccessfulCharge(tx));
        return false;
    } catch (err) {
        if (err.response?.status !== 404) console.warn(`[codm] recheck ${payment.reference} failed:`, err.response?.data?.message || err.message);
        return false;
    }
};

const unconfirmed = (extra = {}) => ({
    status: { $in: ["pending", "failed"] },
    reference: { $not: /^cash_/ },
    refundStatus: null,
    createdAt: { $gt: new Date(Date.now() - SYNC_WINDOW_MS) },
    ...extra,
});

// Re-checks one player's recent unconfirmed checkouts (newest first, at most 5).
const syncPlayerPayments = async (playerId) => {
    const list = await CodmPayment.find(unconfirmed({ playerId })).sort({ createdAt: -1 }).limit(5).lean();
    for (const p of list) {
        if (await recheck(p)) return true;
    }
    return false;
};

// Re-checks everyone's unconfirmed checkouts older than 2 minutes (the return page
// handles the first minutes). Returns how many became paid.
let sweeping = false;
const sweepPendingPayments = async ({ limit = 100 } = {}) => {
    if (sweeping || !secretKey()) return 0;
    sweeping = true;
    let fixed = 0;
    try {
        const list = await CodmPayment.find(unconfirmed({ updatedAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) } }))
            .sort({ createdAt: -1 }).limit(limit).lean();
        for (const p of list) {
            const paidAlready = await CodmPlayer.exists({ _id: p.playerId, paid: true });
            if (paidAlready) continue; // a later checkout already counted; don't take a second payment as the entry
            if (await recheck(p)) {
                fixed += 1;
                console.log(`[codm] payment ${p.reference} confirmed by the background check`);
            }
            await new Promise((r) => setTimeout(r, 250));
        }
    } finally {
        sweeping = false;
    }
    return fixed;
};

// POST /api/v1/codm/payments/sync  (player: "I paid, check again")
const syncMyPayments = async (req, res) => {
    if (!req.player.paid) await syncPlayerPayments(req.player._id);
    const player = await CodmPlayer.findById(req.player._id);
    res.status(StatusCodes.OK).json({ success: !!player.paid, player: toPlayerDTO(player) });
};

// POST /api/v1/codm/admin/payments/sync  (admin: check every unconfirmed checkout now)
const adminSyncPayments = async (req, res) => {
    const pending = await CodmPayment.countDocuments(unconfirmed());
    const fixed = await sweepPendingPayments({ limit: 300 });
    res.status(StatusCodes.OK).json({ checked: pending, confirmed: fixed });
};

// Background check every 5 minutes (each server instance; the checks are idempotent).
if (process.env.NODE_ENV !== "test") {
    const timer = setInterval(() => { sweepPendingPayments().catch((e) => console.error("[codm] sweep failed:", e.message)); }, 5 * 60 * 1000);
    if (timer.unref) timer.unref();
    setTimeout(() => { sweepPendingPayments().catch(() => {}); }, 30 * 1000).unref?.();
}

module.exports = { initializePayment, verifyPayment, webhook, applySuccessfulCharge, paystack, isCancelled, syncMyPayments, adminSyncPayments, sweepPendingPayments };
