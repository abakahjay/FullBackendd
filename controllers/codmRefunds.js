const { StatusCodes } = require("http-status-codes");
const CodmPlayer = require("../models/CodmPlayer.js");
const CodmTeam = require("../models/CodmTeam.js");
const CodmPayment = require("../models/CodmPayment.js");
const CodmBracket = require("../models/CodmBracket.js");
const CodmEventState = require("../models/CodmEventState.js");
const { paystack } = require("./codmPayments.js");
const { removeFromTeam } = require("./codmTeams.js");
const { check, clearPublicCache, entryPesewasOf } = require("../utils/codm.js");
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
            { $set: { refundStatus: "manual", refundAmountPesewas: payment.amountPesewas, refundRequestedAt: new Date(), refundRequestedBy: req.player.email, refundUpdatedAt: new Date(), refundError: null } },
            { new: true }
        );
        if (!claimed) throw new BadRequestError("This payment is already being refunded.");
        await unpayPlayer(claimed, { leaveTeam: !cancelled });
        return res.status(StatusCodes.OK).json({ refund: toRow(claimed, player), message: `Recorded: hand GH₵${(payment.amountPesewas / 100).toFixed(2)} cash back to ${player.fullName}.` });
    }

    const result = await refundOnline(payment._id, req.player.email, {
        customer: "Refund of your CODM Campus Showdown entry fee.",
        merchant: `CODM refund for ${player.ign} (${player.codmUid})`,
    });
    if (!result) throw new BadRequestError("This payment is already being refunded.");
    if (result.refundStatus === "failed") throw new BadRequestError(`Paystack refused the refund: ${result.refundError}`);
    await unpayPlayer(result, { leaveTeam: !cancelled });
    res.status(StatusCodes.OK).json({ refund: toRow(result, player), message: `Refund of GH₵${(result.refundAmountPesewas / 100).toFixed(2)} sent to Paystack for ${player.fullName}. It reaches them in 3 to 10 working days.` });
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

module.exports = { refundPlayer, refundAll, listRefunds };
