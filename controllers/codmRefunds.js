const { StatusCodes } = require("http-status-codes");
const CodmPlayer = require("../models/CodmPlayer.js");
const CodmTeam = require("../models/CodmTeam.js");
const CodmPayment = require("../models/CodmPayment.js");
const CodmBracket = require("../models/CodmBracket.js");
const CodmEventState = require("../models/CodmEventState.js");
const CodmRefundFunding = require("../models/CodmRefundFunding.js");
const { detectNetwork } = require("../utils/ghana.js");
const { paystack } = require("./codmPayments.js");
const { removeFromTeam } = require("./codmTeams.js");
const { check, clearPublicCache, entryPesewasOf, eventConfig } = require("../utils/codm.js");
const { BadRequestError, NotFoundError } = require("../errors");

// Refunds for the CODM entry fee (admin only).
//
// - One player:  POST /admin/players/:playerId/refund { confirm: true }
//   Online payments go back through Paystack's Refund API; cash payments are only
//   recorded ("manual") because the organiser hands the cash back. The player
//   becomes unpaid and leaves their team. Not allowed once the bracket is drawn,
//   unless the tournament is cancelled (removing a player would break the bracket).
// - Everyone:    POST /admin/refunds/all { confirm: "CANCEL AND REFUND", reason }
//   Marks the tournament cancelled (registration, payments and team changes stop)
//   and refunds every Paystack payment in the background. Running it again only
//   retries the ones that are not refunded yet. Cash entries are listed for the
//   organiser to hand back and record one by one.
// - Status:      GET /admin/refunds   (also refreshes pending ones from Paystack)
//
// Refunds return the entry fee only (amount: entryPesewasOf), since Paystack keeps its
// processing fee anyway. A Starter Business has no
// balance: refunds come out of payouts Paystack has not sent yet. Paystack's own
// error (e.g. not enough pending payout) is stored in refundError and shown.
//
// Each payment is claimed atomically before Paystack is called, so two admins,
// two clicks or two server instances can never refund the same payment twice.
// A claim left behind by a crash expires after 10 minutes and can be retried;
// Paystack answers "fully reversed" if that refund had in fact gone through.

const CLAIM_TTL_MS = 10 * 60 * 1000;
const DONE = ["pending", "processing", "processed", "needs-attention", "manual"];
const isCash = (reference) => String(reference || "").startsWith("cash_");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const claimable = () => ({
    $or: [
        { refundStatus: null },
        { refundStatus: "failed" },
        { refundStatus: "requesting", refundRequestedAt: { $lt: new Date(Date.now() - CLAIM_TTL_MS) } },
    ],
});

// The player stops being a paid entrant once the refund is accepted.
const unpayPlayer = async (payment, { leaveTeam }) => {
    const player = await CodmPlayer.findOneAndUpdate(
        { _id: payment.playerId, paymentReference: payment.reference },
        { paid: false, paidAt: null, paymentReference: null, paymentChannel: null, refundedAt: new Date() },
        { new: true }
    );
    if (player && leaveTeam && player.teamId) {
        const team = await CodmTeam.findById(player.teamId);
        if (team) await removeFromTeam(team, player._id);
        else await CodmPlayer.updateOne({ _id: player._id }, { teamId: null });
    }
    clearPublicCache();
};

// Calls Paystack for one online payment. Returns the updated payment, or null if
// someone else already holds it / it is already refunded.
const refundOnline = async (paymentId, adminEmail, note) => {
    const now = new Date();
    const payment = await CodmPayment.findOneAndUpdate(
        { _id: paymentId, status: "success", reference: { $not: /^cash_/ }, ...claimable() },
        { $set: { refundStatus: "requesting", refundRequestedAt: now, refundRequestedBy: adminEmail, refundError: null } },
        { new: true }
    );
    if (!payment) return null;
    let update;
    try {
        // Refund the entry fee only (GH₵50). Paystack keeps its processing fee on a
        // refund anyway, so the GH₵1 the player paid on top is already gone.
        const { data } = await paystack().post("/refund", {
            transaction: payment.reference,
            amount: entryPesewasOf(payment),
            customer_note: note.customer,
            merchant_note: `${note.merchant} (by ${adminEmail})`,
        });
        const r = data.data || {};
        update = { refundStatus: DONE.includes(r.status) ? r.status : "pending", refundId: r.id ?? null, refundAmountPesewas: r.amount ?? entryPesewasOf(payment) };
    } catch (err) {
        const msg = String(err.response?.data?.message || err.message || "Paystack did not answer").slice(0, 300);
        update = /fully (reversed|refunded)|already been (reversed|refunded)/i.test(msg)
            ? { refundStatus: "processed", refundAmountPesewas: entryPesewasOf(payment), refundError: null }
            : { refundStatus: "failed", refundError: msg };
        if (update.refundStatus === "failed") console.warn(`[codm] refund failed for ${payment.reference}: ${msg}`);
    }
    const saved = await CodmPayment.findByIdAndUpdate(payment._id, { $set: { ...update, refundUpdatedAt: new Date() } }, { new: true });
    return saved;
};

const isCancelled = async () => !!(await CodmEventState.exists({ _id: "main", cancelledAt: { $ne: null } }));

// ---------------------------------------------------------------------------
// POST /api/v1/codm/admin/players/:playerId/refund  { confirm: true }
const refundPlayer = async (req, res) => {
    const playerId = check.objectId(req.params.playerId, "player");
    if ((req.body || {}).confirm !== true) throw new BadRequestError("Confirm the refund first.");
    const out = await refundOnePlayer(playerId, req.player.email);
    res.status(StatusCodes.OK).json(out);
};

// Refunds one player and returns { refund, message }; throws BadRequestError when it can't.
// A Paystack refusal is thrown with `needsFunding: true` so the admin page can offer
// to fund it from the organiser's MoMo.
const refundOnePlayer = async (playerId, adminEmail) => {
    const player = await CodmPlayer.findById(playerId);
    if (!player) throw new NotFoundError("Player not found");
    if (!player.paid || !player.paymentReference) throw new BadRequestError(`${player.ign} has no entry payment to refund.`);
    const cancelled = await isCancelled();
    if (!cancelled && player.teamId && await CodmBracket.exists({ _id: "main" })) {
        throw new BadRequestError("The bracket has been drawn, so players can't be taken out of their teams. Reset the bracket first, or cancel the tournament and refund everyone.");
    }
    const payment = await CodmPayment.findOne({ reference: player.paymentReference, status: "success" });
    if (!payment) throw new BadRequestError("This player's payment record was not found. Refund it from the Paystack dashboard.");

    if (isCash(payment.reference)) {
        const claimed = await CodmPayment.findOneAndUpdate(
            { _id: payment._id, ...claimable() },
            { $set: { refundStatus: "manual", refundAmountPesewas: payment.amountPesewas, refundRequestedAt: new Date(), refundRequestedBy: adminEmail, refundUpdatedAt: new Date(), refundError: null } },
            { new: true }
        );
        if (!claimed) throw new BadRequestError("This payment is already being refunded.");
        await unpayPlayer(claimed, { leaveTeam: !cancelled });
        return { refund: toRow(claimed, player), message: `Recorded: hand GH₵${(payment.amountPesewas / 100).toFixed(2)} cash back to ${player.fullName}.` };
    }

    const result = await refundOnline(payment._id, adminEmail, {
        customer: "Refund of your CODM Campus Showdown entry fee.",
        merchant: `CODM refund for ${player.ign} (${player.codmUid})`,
    });
    if (!result) throw new BadRequestError("This payment is already being refunded.");
    if (result.refundStatus === "failed") {
        const err = new BadRequestError(`Paystack refused the refund: ${result.refundError}`);
        err.needsFunding = true;
        throw err;
    }
    await unpayPlayer(result, { leaveTeam: !cancelled });
    return { refund: toRow(result, player), message: `Refund of GH₵${(result.refundAmountPesewas / 100).toFixed(2)} sent to Paystack for ${player.fullName}. It reaches them in 3 to 10 working days.` };
};

// ---------------------------------------------------------------------------
// Background run over every online payment that still needs a refund.
let running = false;
const runAllRefunds = async (adminEmail) => {
    if (running) return;
    running = true;
    try {
        const todo = await CodmPayment.find({ status: "success", reference: { $not: /^cash_/ }, ...claimable() }).select("_id").lean();
        for (const { _id } of todo) {
            try {
                const result = await refundOnline(_id, adminEmail, {
                    customer: "The CODM Campus Showdown was cancelled. This is a refund of your entry fee.",
                    merchant: "CODM tournament cancelled",
                });
                if (result && result.refundStatus !== "failed") await unpayPlayer(result, { leaveTeam: false });
            } catch (err) {
                console.error("[codm] refund run error:", err.message);
            }
            await sleep(400); // stay well inside Paystack's rate limits
        }
    } finally {
        running = false;
    }
};

const CONFIRM_ALL = "CANCEL AND REFUND";

// POST /api/v1/codm/admin/refunds/all  { confirm: "CANCEL AND REFUND", reason }
const refundAll = async (req, res) => {
    const b = req.body || {};
    if (b.confirm !== CONFIRM_ALL) throw new BadRequestError(`Type ${CONFIRM_ALL} to confirm.`);
    const reason = check.text(b.reason, "reason", { min: 3, max: 300 });
    await CodmEventState.updateOne(
        { _id: "main", cancelledAt: null },
        { $set: { cancelledAt: new Date(), cancelledBy: req.player.email, cancelReason: reason } },
        { upsert: true }
    ).catch((err) => { if (err.code !== 11000) throw err; }); // already cancelled: keep the first reason
    clearPublicCache();
    runAllRefunds(req.player.email).catch((err) => console.error("[codm] refund run failed:", err.message));
    res.status(StatusCodes.ACCEPTED).json(await buildRefunds());
};

// ---------------------------------------------------------------------------
const toRow = (p, player) => ({
    paymentId: String(p._id),
    reference: p.reference,
    method: isCash(p.reference) ? "cash" : "paystack",
    channel: p.channel,
    amountGhs: entryPesewasOf(p) / 100, // the entry fee
    chargedGhs: p.amountPesewas / 100, // what the player paid, Paystack fee included (a refund returns only the entry)
    paidAt: p.paidAt,
    refundStatus: p.refundStatus,
    refundAmountGhs: p.refundAmountPesewas ? p.refundAmountPesewas / 100 : null,
    refundError: p.refundError,
    refundRequestedAt: p.refundRequestedAt,
    refundRequestedBy: p.refundRequestedBy,
    refundUpdatedAt: p.refundUpdatedAt,
    player: player ? { id: String(player._id), fullName: player.fullName, ign: player.ign, phone: player.phone, email: player.email, teamId: player.teamId ? String(player.teamId) : null } : null,
});

// Asks Paystack about refunds still on their way (at most 20 per call, each at most once a minute).
const refreshPending = async () => {
    const stale = await CodmPayment.find({
        refundId: { $ne: null },
        refundStatus: { $in: ["pending", "processing"] },
        refundUpdatedAt: { $lt: new Date(Date.now() - 60 * 1000) },
    }).limit(20).lean();
    await Promise.all(stale.map(async (p) => {
        try {
            const { data } = await paystack().get(`/refund/${p.refundId}`);
            const status = data.data?.status;
            const set = { refundUpdatedAt: new Date() };
            if (DONE.includes(status) || status === "failed") set.refundStatus = status;
            await CodmPayment.updateOne({ _id: p._id }, { $set: set });
        } catch (err) {
            await CodmPayment.updateOne({ _id: p._id }, { $set: { refundUpdatedAt: new Date() } });
        }
    }));
};

const buildRefunds = async () => {
    const [state, payments] = await Promise.all([
        CodmEventState.findById("main").lean(),
        CodmPayment.find({ status: "success" }).sort({ paidAt: 1 }).lean(),
    ]);
    const players = await CodmPlayer.find({ _id: { $in: payments.map((p) => p.playerId) } }).lean();
    const byId = new Map(players.map((p) => [String(p._id), p]));
    const rows = payments.map((p) => toRow(p, byId.get(String(p.playerId))));
    const sum = (list) => Math.round(list.reduce((s, r) => s + r.amountGhs, 0) * 100) / 100;
    const online = rows.filter((r) => r.method === "paystack");
    const cash = rows.filter((r) => r.method === "cash");
    return {
        cancelled: !!state?.cancelledAt,
        cancelledAt: state?.cancelledAt || null,
        cancelledBy: state?.cancelledBy || null,
        cancelReason: state?.cancelReason || null,
        running,
        confirmPhrase: CONFIRM_ALL,
        totals: {
            onlinePayments: online.length,
            onlineGhs: sum(online),
            onlineToRefund: online.filter((r) => !r.refundStatus || r.refundStatus === "failed").length,
            onlineRefunded: online.filter((r) => DONE.includes(r.refundStatus)).length,
            onlineFailed: online.filter((r) => r.refundStatus === "failed").length,
            cashPayments: cash.length,
            cashGhs: sum(cash.filter((r) => !r.refundStatus)),
            cashToHandBack: cash.filter((r) => !r.refundStatus).length,
        },
        rows,
    };
};

// GET /api/v1/codm/admin/refunds
const listRefunds = async (req, res) => {
    await refreshPending();
    res.status(StatusCodes.OK).json(await buildRefunds());
};

// ---------------------------------------------------------------------------
// Funding a refund from the organiser's MoMo.
//
// A Starter Business has no Paystack balance: refunds come out of payouts not yet
// sent. When there are none, the organiser pays the entry back into Paystack with a
// MoMo prompt on their own phone (they type their PIN there; nothing here sees it),
// and once Paystack confirms that charge the player's refund is requested.
// The charge is exactly the entry (GH₵50), as the organiser chose. Paystack takes its
// 1.95% from it, so about GH₵49.02 lands; the refund of GH₵50 can still be refused if
// nothing else is waiting to be paid out, and the page then says so.
const PROVIDER = { MTN: "mtn", Telecel: "vod", AirtelTigo: "atl" };
const localPhone = (phone) => { const d = String(phone || "").replace(/[^\d]/g, ""); return d.startsWith("233") ? `0${d.slice(3)}` : d; };

// POST /api/v1/codm/admin/players/:playerId/refund/fund  { phone? }
const fundRefund = async (req, res) => {
    const playerId = check.objectId(req.params.playerId, "player");
    const player = await CodmPlayer.findById(playerId);
    if (!player || !player.paid || !player.paymentReference || isCash(player.paymentReference)) throw new BadRequestError("This player has no online payment to refund.");
    const payment = await CodmPayment.findOne({ reference: player.paymentReference, status: "success", ...claimable() });
    if (!payment) throw new BadRequestError("This payment is already refunded or being refunded.");
    const open = await CodmRefundFunding.findOne({ paymentId: payment._id, status: "pending", createdAt: { $gt: new Date(Date.now() - 4 * 60 * 1000) } });
    if (open) throw new BadRequestError("A MoMo prompt for this refund is already waiting on your phone. Approve it, or wait 4 minutes and try again.");

    const phone = localPhone((req.body || {}).phone ? check.phone(req.body.phone) : req.player.phone);
    const network = detectNetwork(phone);
    if (!network) throw new BadRequestError("Add your MoMo number to your account first (Edit on your row), then try again.");
    const entry = entryPesewasOf(payment);
    const amount = entry; // the organiser pays exactly the entry (GH₵50); Paystack's fee on it comes out of what lands
    const reference = `codmfund_${payment._id}_${Date.now()}`;
    await CodmRefundFunding.create({ reference, paymentId: payment._id, playerId: player._id, amountPesewas: amount, phone, adminEmail: req.player.email });

    let data;
    try {
        ({ data } = await paystack().post("/charge", {
            email: req.player.email,
            amount,
            currency: "GHS",
            reference,
            mobile_money: { phone, provider: PROVIDER[network] },
            metadata: { app: "codm", purpose: "refund-funding", paymentId: String(payment._id), playerId: String(player._id) },
        }));
    } catch (err) {
        const msg = String(err.response?.data?.message || err.message || "Paystack did not answer").slice(0, 300);
        await CodmRefundFunding.updateOne({ reference }, { status: "failed", message: msg });
        throw new BadRequestError(`Paystack couldn't start the MoMo payment: ${msg}`);
    }
    const ch = data.data || {};
    if (ch.status === "success") return res.json(await finishFunding(reference));
    if (ch.status === "failed") {
        await CodmRefundFunding.updateOne({ reference }, { status: "failed", message: ch.message || ch.gateway_response || "Declined" });
        throw new BadRequestError(`The MoMo payment was declined: ${ch.message || ch.gateway_response || "no reason given"}`);
    }
    res.status(StatusCodes.OK).json({
        reference, status: ch.status === "send_otp" ? "send_otp" : "pending",
        amountGhs: amount / 100, phone, network,
        displayText: ch.display_text || `Approve the GH₵${(amount / 100).toFixed(2)} prompt on ${phone} with your MoMo PIN.`,
    });
};

// POST /api/v1/codm/admin/refunds/fund/:reference/otp  { otp }  (some networks send an OTP first)
const submitFundingOtp = async (req, res) => {
    const reference = String(req.params.reference || "");
    if (!/^codmfund_[a-f0-9]{24}_\d{10,16}$/.test(reference)) throw new BadRequestError("Unknown payment.");
    const otp = String((req.body || {}).otp || "").trim();
    if (!/^\d{4,8}$/.test(otp)) throw new BadRequestError("Enter the code sent to your phone.");
    try {
        const { data } = await paystack().post("/charge/submit_otp", { otp, reference });
        const ch = data.data || {};
        res.json({ reference, status: ch.status === "success" ? "success" : "pending", displayText: ch.display_text || "Now approve the prompt on your phone." });
    } catch (err) {
        throw new BadRequestError(`Paystack didn't accept the code: ${String(err.response?.data?.message || err.message).slice(0, 200)}`);
    }
};

// Checks the funding charge and, once it has succeeded, requests the player's refund (once).
const finishFunding = async (reference) => {
    const row = await CodmRefundFunding.findOne({ reference });
    if (!row) throw new NotFoundError("Unknown payment.");
    if (row.status === "pending") {
        let tx = {};
        try { ({ data: { data: tx = {} } } = await paystack().get(`/transaction/verify/${encodeURIComponent(reference)}`)); } catch { /* still waiting */ }
        if (tx.status === "success" && tx.amount === row.amountPesewas && tx.currency === "GHS" && tx.metadata?.purpose === "refund-funding") {
            await CodmRefundFunding.updateOne({ _id: row._id, status: "pending" }, { status: "success", message: null });
            row.status = "success";
        } else if (["failed", "abandoned", "reversed"].includes(tx.status) && Date.now() - row.createdAt > 3 * 60 * 1000) {
            await CodmRefundFunding.updateOne({ _id: row._id, status: "pending" }, { status: "failed", message: tx.gateway_response || tx.message || tx.status });
            row.status = "failed";
            row.message = tx.gateway_response || tx.message || tx.status;
        }
    }
    if (row.status === "failed") return { reference, status: "failed", message: row.message || "The MoMo payment didn't go through." };
    if (row.status === "pending") return { reference, status: "pending" };

    // Paid in. Request the refund once.
    const claim = await CodmRefundFunding.findOneAndUpdate({ _id: row._id, refundStarted: false }, { refundStarted: true }, { new: true });
    if (!claim) return { reference, status: "success", refund: row.refundResult || "already requested" };
    let out;
    try {
        out = await refundOnePlayer(row.playerId, row.adminEmail);
        await CodmRefundFunding.updateOne({ _id: row._id }, { refundResult: "requested" });
        return { reference, status: "success", refunded: true, message: `Your MoMo payment went through. ${out.message}`, refund: out.refund };
    } catch (err) {
        await CodmRefundFunding.updateOne({ _id: row._id }, { refundResult: `failed: ${err.message}` });
        return { reference, status: "success", refunded: false, message: `Your MoMo payment went through, but the refund still failed: ${err.message}. The money is in Paystack; try Refund again in a few minutes.` };
    }
};

// GET /api/v1/codm/admin/refunds/fund/:reference
const fundingStatus = async (req, res) => {
    const reference = String(req.params.reference || "");
    if (!/^codmfund_[a-f0-9]{24}_\d{10,16}$/.test(reference)) throw new BadRequestError("Unknown payment.");
    res.json(await finishFunding(reference));
};

module.exports = { refundPlayer, refundAll, listRefunds, fundRefund, submitFundingOtp, fundingStatus };
