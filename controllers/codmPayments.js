const crypto = require("crypto");
const axios = require("axios");
const { StatusCodes } = require("http-status-codes");
const CodmPlayer = require("../models/CodmPlayer.js");
const CodmPayment = require("../models/CodmPayment.js");
const { BadRequestError, NotFoundError } = require("../errors");
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
    if (data.amount !== payment.amountPesewas || data.metadata?.playerId !== String(payment.playerId) || data.metadata?.app !== "codm") {
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
    const player = req.player;
    if (player.paid) throw new BadRequestError("You have already paid. See you on match day!");

    const cfg = eventConfig();
    const amount = pesewas(cfg.entryFeeGhs);
    const reference = `codm_${player._id}_${Date.now()}${crypto.randomBytes(3).toString("hex")}`;
    await CodmPayment.create({ reference, playerId: player._id, amountPesewas: amount });

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

module.exports = { initializePayment, verifyPayment, webhook, applySuccessfulCharge };
